declare const spindle: import('lumiverse-spindle-types').SpindleAPI

import { DEFAULT_SETTINGS, validateSettings, type Settings } from './settings'
import {
  fingerprintSwipeContent,
  type GenerationHistoryInput,
  type GenerationHistoryRecord,
  type GenerationTarget,
} from './history'
import {
  HISTORY_STATE_PATH,
  HISTORY_STORE_PREFIX,
  appendRecordToSnapshot,
  createHistoryRecord,
  historyChatSnapshotPath,
  historyEpochPrefix,
  isGenerationHistoryRecord,
  isHistoryStateV1,
  parseChatHistorySnapshotV1,
  recordMatchesInput,
  recordMatchesTarget,
  selectNewestSnapshot,
  type ChatHistorySnapshotV1,
  type HistoryStateV1,
  type SnapshotCandidate,
  type SnapshotSlot,
} from './history-store'

// ── Types ──

type FrontendMessage =
  | { type: 'request_settings' }
  | { type: 'update_settings'; settings: Partial<Settings> }
  | { type: 'insert_into_message'; requestId?: string; imageId: string; messageId: string; chatId: string; target?: GenerationTarget; replace?: boolean; replaceImageId?: string }
  | { type: 'resolve_generation_target'; requestId: string; chatId: string; messageId: string }
  | { type: 'append_generation_history'; requestId: string; target: GenerationTarget; entry: GenerationHistoryInput }
  | { type: 'get_generation_history'; requestId: string; target: GenerationTarget }
  | { type: 'get_generation_record'; requestId: string; chatId: string; imageId: string }
  | { type: 'clear_generation_history'; requestId: string }
  | { type: 'delete_image'; messageId: string; chatId: string }
  | { type: 'delete_all_images'; messageId: string; chatId: string }
  | { type: 'show_toast'; level: 'info' | 'success' | 'warning' | 'error'; message: string }
  | { type: 'resolve_shutter_tag'; requestId: string; chatId: string; messageId: string; index: number }

// Current settings used by backend features that run outside a frontend action.
let liveSettings: Settings = { ...DEFAULT_SETTINGS }

// ── Storage ──

async function loadSettings(userId?: string): Promise<Settings> {
  const saved = await spindle.userStorage.getJson('settings.json', { fallback: {}, userId }) as Partial<Settings>
  return validateSettings({ ...DEFAULT_SETTINGS, ...saved })
}

async function saveSettings(patch: Partial<Settings>, userId?: string): Promise<Settings> {
  const current = await loadSettings(userId)
  const merged = validateSettings({ ...current, ...patch })
  await spindle.userStorage.setJson('settings.json', merged, { indent: 2, userId })
  return merged
}

void loadSettings()
  .then(settings => {
    liveSettings = settings
  })
  .catch(error => {
    spindle.log.warn(
      `[settings] Failed to load saved settings; using defaults: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  })

// ── Durable generation history ──

const historyQueues = new Map<string, Promise<void>>()

type StoredJsonResult =
  | { status: 'absent' }
  | { status: 'valid'; value: unknown }
  | { status: 'invalid'; error: string }

type LoadedChatHistory = {
  current: SnapshotCandidate | null
  validCandidates: SnapshotCandidate[]
  invalidSlots: SnapshotSlot[]
}

function historyQueueKey(userId?: string): string {
  return userId || '__extension_owner__'
}

function withHistoryQueue<T>(userId: string | undefined, operation: () => Promise<T>): Promise<T> {
  const key = historyQueueKey(userId)
  const previous = historyQueues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  const settled = next.then(() => undefined, () => undefined)
  historyQueues.set(key, settled)
  void settled.finally(() => {
    if (historyQueues.get(key) === settled) historyQueues.delete(key)
  })
  return next
}

async function readStoredJson(path: string, userId?: string): Promise<StoredJsonResult> {
  if (!await spindle.userStorage.exists(path, userId)) return { status: 'absent' }
  try {
    return { status: 'valid', value: await spindle.userStorage.getJson(path, { userId }) }
  } catch (error) {
    return { status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

async function writeAndVerifyState(state: HistoryStateV1, userId?: string): Promise<void> {
  await spindle.userStorage.setJson(HISTORY_STATE_PATH, state, { indent: 2, userId })
  const stored = await readStoredJson(HISTORY_STATE_PATH, userId)
  if (stored.status !== 'valid' || !isHistoryStateV1(stored.value) || stored.value.epoch !== state.epoch) {
    throw new Error('Generation History state could not be verified after writing.')
  }
}

async function writeAndVerifySnapshot(
  snapshot: ChatHistorySnapshotV1,
  slot: SnapshotSlot,
  userId?: string,
): Promise<void> {
  const path = historyChatSnapshotPath(snapshot.chatId, snapshot.epoch, slot)
  try {
    await spindle.userStorage.setJson(path, snapshot, { indent: 2, userId })
    const stored = await readStoredJson(path, userId)
    const parsed = stored.status === 'valid'
      ? parseChatHistorySnapshotV1(stored.value, { epoch: snapshot.epoch, chatId: snapshot.chatId })
      : null
    if (!parsed
      || parsed.malformedRecordCount > 0
      || JSON.stringify(parsed.snapshot) !== JSON.stringify(snapshot)
    ) {
      throw new Error(`Generation History snapshot ${slot.toUpperCase()} could not be verified after writing.`)
    }
  } catch (error) {
    // The other slot remains the authoritative snapshot. Remove a failed slot
    // so a first interrupted write cannot permanently wedge this chat.
    await spindle.userStorage.delete(path, userId).catch(() => {})
    throw error
  }
}

type PreReleaseHistoryState = {
  version: 1
  epoch: number
}

function isPreReleaseHistoryState(value: unknown): value is PreReleaseHistoryState {
  const state = value as PreReleaseHistoryState | null
  return !!state
    && state.version === 1
    && Number.isInteger(state.epoch)
    && state.epoch > 0
}

async function migratePreReleaseHistoryUnlocked(
  legacyState: PreReleaseHistoryState,
  userId?: string,
): Promise<HistoryStateV1> {
  const legacyEpoch = legacyState.epoch
  const recordsByChat = new Map<string, GenerationHistoryRecord[]>()
  const targetPrefix = `${HISTORY_STORE_PREFIX}/epochs/${legacyEpoch}/targets/`
  const paths = await spindle.userStorage.list(targetPrefix, userId)

  for (const relativePath of paths) {
    const stored = await readStoredJson(`${targetPrefix}${relativePath}`, userId)
    if (stored.status !== 'valid' || !isGenerationHistoryRecord(stored.value)) {
      spindle.log.warn(`[history] Skipped malformed pre-release record: ${relativePath}`)
      continue
    }
    const record = stored.value
    if (record.target.historyEpoch !== legacyEpoch) continue
    const records = recordsByChat.get(record.target.chatId) ?? []
    const existing = records.find(entry => entry.imageId === record.imageId)
    if (!existing) records.push(record)
    else if (!recordMatchesInput(existing, record.target, record)) {
      spindle.log.warn(`[history] Conflicting pre-release record for image ${record.imageId}; kept the first valid copy.`)
    }
    recordsByChat.set(record.target.chatId, records)
  }

  for (const [chatId, records] of recordsByChat) {
    records.sort((a, b) => a.createdAt - b.createdAt || a.imageId.localeCompare(b.imageId))
    const timestamp = Date.now()
    const snapshot: ChatHistorySnapshotV1 = {
      schemaVersion: 1,
      epoch: legacyEpoch,
      chatId,
      revision: Math.max(1, records.length),
      createdAt: timestamp,
      updatedAt: timestamp,
      records,
    }
    await writeAndVerifySnapshot(snapshot, 'a', userId)
  }

  const state: HistoryStateV1 = { schemaVersion: 1, epoch: legacyEpoch }
  await writeAndVerifyState(state, userId)
  if (recordsByChat.size > 0) {
    spindle.log.info(`[history] Migrated pre-release history into ${recordsByChat.size} compact chat snapshot${recordsByChat.size === 1 ? '' : 's'}.`)
  }
  return state
}

async function inferPreReleaseStateWithoutStateUnlocked(
  existingFiles: string[],
  userId?: string,
): Promise<PreReleaseHistoryState | null> {
  // The unreleased 1.0.7 build used { version: 1, epoch: 1 } as an in-memory
  // fallback but did not persist state.json until Clear History was used. A
  // tester can therefore have valid epoch-1 target records with no state file.
  // Only recognise that exact legacy file layout; never infer ownership for
  // compact chat snapshots or unknown files.
  const legacyPath = /^epochs\/(\d+)\/(targets|records)\/.+\.json$/
  const epochs = new Set<number>()
  const targetPaths: Array<{ epoch: number; relativePath: string }> = []

  for (const listedPath of existingFiles) {
    const relativePath = listedPath.replace(/^\/+/, '')
    const match = legacyPath.exec(relativePath)
    if (!match) return null
    const epoch = Number.parseInt(match[1] ?? '', 10)
    if (!Number.isInteger(epoch) || epoch <= 0) return null
    epochs.add(epoch)
    if (match[2] === 'targets') targetPaths.push({ epoch, relativePath })
  }

  if (epochs.size !== 1 || targetPaths.length === 0) return null
  const [epoch] = epochs
  if (!epoch) return null

  let validRecordCount = 0
  for (const targetPath of targetPaths) {
    const stored = await readStoredJson(`${HISTORY_STORE_PREFIX}/${targetPath.relativePath}`, userId)
    if (stored.status !== 'valid' || !isGenerationHistoryRecord(stored.value)) continue
    if (stored.value.target.historyEpoch !== epoch) continue
    validRecordCount++
  }

  return validRecordCount > 0 ? { version: 1, epoch } : null
}

async function loadHistoryStateUnlocked(userId?: string): Promise<HistoryStateV1> {
  const stored = await readStoredJson(HISTORY_STATE_PATH, userId)
  if (stored.status === 'valid') {
    if (isHistoryStateV1(stored.value)) return stored.value
    if (isPreReleaseHistoryState(stored.value)) {
      return migratePreReleaseHistoryUnlocked(stored.value, userId)
    }
    throw new Error('Generation History state has an unsupported or malformed schema.')
  }
  if (stored.status === 'invalid') {
    throw new Error('Generation History state is corrupt and was not overwritten.')
  }

  const existingFiles = await spindle.userStorage.list(HISTORY_STORE_PREFIX, userId)
  if (existingFiles.length > 0) {
    const inferredLegacyState = await inferPreReleaseStateWithoutStateUnlocked(existingFiles, userId)
    if (inferredLegacyState) {
      spindle.log.info(
        `[history] Found pre-release epoch ${inferredLegacyState.epoch} history without state.json; importing it into the public v1 snapshot store.`,
      )
      return migratePreReleaseHistoryUnlocked(inferredLegacyState, userId)
    }
    throw new Error('Generation History files exist without a readable state file and were not overwritten.')
  }

  const state: HistoryStateV1 = { schemaVersion: 1, epoch: 1 }
  await writeAndVerifyState(state, userId)
  return state
}

function loadHistoryState(userId?: string): Promise<HistoryStateV1> {
  return withHistoryQueue(userId, () => loadHistoryStateUnlocked(userId))
}

async function loadChatHistoryUnlocked(
  chatId: string,
  epoch: number,
  userId?: string,
): Promise<LoadedChatHistory> {
  const validCandidates: SnapshotCandidate[] = []
  const invalidSlots: SnapshotSlot[] = []

  for (const slot of ['a', 'b'] as const) {
    const stored = await readStoredJson(historyChatSnapshotPath(chatId, epoch, slot), userId)
    if (stored.status === 'absent') continue
    const parsed = stored.status === 'valid'
      ? parseChatHistorySnapshotV1(stored.value, { chatId, epoch })
      : null
    if (!parsed || parsed.malformedRecordCount > 0) {
      invalidSlots.push(slot)
      if (parsed?.malformedRecordCount) {
        spindle.log.warn(
          `[history] Snapshot ${slot.toUpperCase()} for chat ${chatId} contains ${parsed.malformedRecordCount} malformed record(s); using a complete alternate snapshot when available.`,
        )
      }
      continue
    }
    validCandidates.push({ slot, parsed })
  }

  const current = selectNewestSnapshot(validCandidates)
  if (!current && invalidSlots.length > 0) {
    throw new Error(
      `No complete Generation History snapshot is readable for this chat (invalid slot${invalidSlots.length === 1 ? '' : 's'}: ${invalidSlots.join(', ')}).`,
    )
  }
  if (current && invalidSlots.length > 0) {
    spindle.log.warn(`[history] Recovered chat ${chatId} from snapshot ${current.slot.toUpperCase()}; invalid slot: ${invalidSlots.join(', ')}.`)
  }
  return { current, validCandidates, invalidSlots }
}

function sortedTargetHistory(records: GenerationHistoryRecord[], target: GenerationTarget): GenerationHistoryRecord[] {
  return records
    .filter(record => recordMatchesTarget(record, target))
    .sort((a, b) => a.createdAt - b.createdAt || a.imageId.localeCompare(b.imageId))
}

async function loadGenerationHistory(target: GenerationTarget, userId?: string): Promise<GenerationHistoryRecord[]> {
  return withHistoryQueue(userId, async () => {
    const state = await loadHistoryStateUnlocked(userId)
    if (target.historyEpoch !== state.epoch) return []
    const chat = await loadChatHistoryUnlocked(target.chatId, state.epoch, userId)
    return sortedTargetHistory(chat.current?.parsed.snapshot.records ?? [], target)
  })
}

async function appendGenerationHistory(
  target: GenerationTarget,
  input: GenerationHistoryInput,
  userId?: string,
): Promise<GenerationHistoryRecord[]> {
  const settings = await loadSettings(userId)
  if (!settings.generationHistory) return []

  return withHistoryQueue(userId, async () => {
    const state = await loadHistoryStateUnlocked(userId)
    if (target.historyEpoch !== state.epoch) return []

    const loaded = await loadChatHistoryUnlocked(target.chatId, state.epoch, userId)
    const current = loaded.current?.parsed.snapshot ?? null
    if (loaded.current?.parsed.malformedRecordCount) {
      throw new Error('Generation History contains malformed records and was not rewritten automatically.')
    }

    const records = current?.records ?? []
    const existing = records.find(record => record.imageId === input.imageId)
    if (existing) {
      if (!recordMatchesInput(existing, target, input)) {
        throw new Error(`Generation History integrity conflict for image ${input.imageId}.`)
      }
      return sortedTargetHistory(records, target)
    }

    const record = createHistoryRecord(target, input)
    const next = appendRecordToSnapshot(current, record)
    const targetSlot: SnapshotSlot = loaded.current?.slot === 'a' ? 'b' : 'a'
    await writeAndVerifySnapshot(next, targetSlot, userId)

    const stateAfter = await loadHistoryStateUnlocked(userId)
    if (stateAfter.epoch !== target.historyEpoch) return []
    return sortedTargetHistory(next.records, target)
  })
}

async function getGenerationRecord(
  chatId: string,
  imageId: string,
  userId?: string,
): Promise<GenerationHistoryRecord | null> {
  return withHistoryQueue(userId, async () => {
    const state = await loadHistoryStateUnlocked(userId)
    const loaded = await loadChatHistoryUnlocked(chatId, state.epoch, userId)
    return loaded.current?.parsed.snapshot.records.find(record =>
      record.imageId === imageId && record.target.historyEpoch === state.epoch
    ) ?? null
  })
}

async function highestStoredHistoryEpochUnlocked(userId?: string): Promise<number> {
  let highest = 0

  const state = await readStoredJson(HISTORY_STATE_PATH, userId)
  if (state.status === 'valid') {
    if (isHistoryStateV1(state.value) || isPreReleaseHistoryState(state.value)) {
      highest = Math.max(highest, state.value.epoch)
    }
  }

  const paths = await spindle.userStorage.list(`${HISTORY_STORE_PREFIX}/epochs/`, userId)
  for (const relativePath of paths) {
    const epoch = Number.parseInt(relativePath.split('/')[0] ?? '', 10)
    if (Number.isInteger(epoch) && epoch > highest) highest = epoch
  }

  return highest
}

async function clearGenerationHistory(userId?: string): Promise<void> {
  await withHistoryQueue(userId, async () => {
    // Clear is an explicit destructive recovery operation. It must still work
    // when either the current or pre-release state file is malformed.
    const highestEpoch = await highestStoredHistoryEpochUnlocked(userId)
    const next: HistoryStateV1 = { schemaVersion: 1, epoch: Math.max(1, highestEpoch + 1) }

    // Publish and verify the new epoch first. Everything beneath previous
    // epochs immediately becomes inaccessible, even if cleanup is interrupted.
    await writeAndVerifyState(next, userId)

    const epochsPrefix = `${HISTORY_STORE_PREFIX}/epochs/`
    const paths = await spindle.userStorage.list(epochsPrefix, userId)
    const staleEpochs = new Set<number>()
    for (const relativePath of paths) {
      const storedEpoch = Number.parseInt(relativePath.split('/')[0] ?? '', 10)
      if (Number.isInteger(storedEpoch) && storedEpoch < next.epoch) staleEpochs.add(storedEpoch)
    }
    for (const epoch of staleEpochs) {
      await spindle.userStorage.delete(historyEpochPrefix(epoch), userId).catch(() => {})
    }
  })
}

// ── Image manipulation ──
// The 'Remove Image Tags from Context' setting controls whether these tags are stripped from
// the prompt natively via the interceptor below. Shutter-regex-scripts.json is
// the legacy equivalent (same unanchored 'gi' pattern) for installs on a
// Lumiverse old enough to lack the 'interceptor' permission; keep them in sync.

const SHUTTER_IMAGE_SOURCE = String.raw`\n*!\[shutter\]\(/api/v1/(?:images|image-gen/results)/[a-f0-9-]+\)`
const SHUTTER_IMAGE_RE = new RegExp(`${SHUTTER_IMAGE_SOURCE}$`, 'i')
const SHUTTER_IMAGE_GLOBAL_RE = new RegExp(SHUTTER_IMAGE_SOURCE, 'gi')

function stripLastShutterImage(content: string): { content: string; found: boolean } {
  const match = content.match(SHUTTER_IMAGE_RE)
  if (!match) return { content, found: false }
  return { content: content.slice(0, match.index), found: true }
}

function shutterImageIdPattern(imageId: string): RegExp {
  const escaped = imageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(String.raw`\n*!\[shutter\]\(/api/v1/(?:images|image-gen/results)/${escaped}\)`, 'i')
}

function stripShutterImageById(content: string, imageId: string): { content: string; found: boolean } {
  const re = shutterImageIdPattern(imageId)
  if (!re.test(content)) return { content, found: false }
  return { content: content.replace(re, ''), found: true }
}

function containsShutterImageId(content: string, imageId: string): boolean {
  return shutterImageIdPattern(imageId).test(content)
}

function stripAllShutterImages(content: string): { content: string; count: number } {
  let count = 0
  const stripped = content.replace(SHUTTER_IMAGE_GLOBAL_RE, () => { count++; return '' })
  return { content: stripped, count }
}

// ── Image-tag context filtering (interceptor) ──

type LlmMessage = import('lumiverse-spindle-types').LlmMessageDTO

function stripShutterFromLlmMessage(message: LlmMessage): LlmMessage {
  const { content } = message
  if (typeof content === 'string') {
    return { ...message, content: content.replace(SHUTTER_IMAGE_GLOBAL_RE, '') }
  }
  return {
    ...message,
    content: content.map((part: any) =>
      part.type === 'text'
        ? { ...part, text: part.text.replace(SHUTTER_IMAGE_GLOBAL_RE, '') }
        : part,
    ),
  }
}

// ── Message resolution ──

type ShutterMessage = {
  id: string
  content: string
  role: string
  index_in_chat: number
  swipe_id: number
  swipes: string[]
  swipe_dates: number[]
}

function orderedMessages<T extends ShutterMessage>(messages: T[]): T[] {
  return [...messages].sort((a, b) => a.index_in_chat - b.index_in_chat)
}

function resolveTarget<T extends ShutterMessage>(messages: T[], messageId: string): { target?: T; error?: string } {
  if (messageId === '__last__') {
    const ordered = orderedMessages(messages)
    const target = ordered[ordered.length - 1]
    return target ? { target } : { error: 'No messages in chat.' }
  }
  const target = messages.find(m => m.id === messageId)
  return target ? { target } : { error: 'Message not found.' }
}

function buildGenerationTarget(chatId: string, message: ShutterMessage, historyEpoch: number): GenerationTarget {
  const swipeId = Number.isFinite(message.swipe_id) ? message.swipe_id : 0
  const swipeContent = message.swipes?.[swipeId] ?? message.content
  const rawDate = message.swipe_dates?.[swipeId]
  const swipeDate = Number.isFinite(rawDate) && rawDate > 0 ? rawDate : null
  const duplicateSwipeDate = swipeDate !== null
    && message.swipe_dates.filter(value => value === swipeDate).length > 1

  return {
    chatId,
    messageId: message.id,
    swipeId,
    swipeDate,
    swipeFingerprint: fingerprintSwipeContent(swipeContent),
    duplicateSwipeDate,
    historyEpoch,
  }
}

function resolvePinnedSwipeIndex(message: ShutterMessage, target: GenerationTarget): number | null {
  const swipes = Array.isArray(message.swipes) && message.swipes.length > 0 ? message.swipes : [message.content]
  const dates = Array.isArray(message.swipe_dates) ? message.swipe_dates : []

  if (target.swipeDate !== null) {
    const candidates: number[] = []
    for (let i = 0; i < dates.length; i++) if (dates[i] === target.swipeDate) candidates.push(i)
    if (candidates.length === 1) return candidates[0]!
    if (candidates.length > 1) {
      const byFingerprint = candidates.filter(i => fingerprintSwipeContent(swipes[i] ?? '') === target.swipeFingerprint)
      if (byFingerprint.length === 1) return byFingerprint[0]!
    }
  }

  if (target.swipeId >= 0 && target.swipeId < swipes.length) {
    const content = swipes[target.swipeId] ?? ''
    if (fingerprintSwipeContent(content) === target.swipeFingerprint) return target.swipeId
  }

  return null
}

// ── Frontend messages ──

spindle.onFrontendMessage(async (raw: unknown, userId: string) => {
  const payload = raw as FrontendMessage
  try {
    switch (payload.type) {
      case 'request_settings': {
        const settings = await loadSettings(userId)
        liveSettings = settings
        spindle.sendToFrontend({ type: 'settings', settings }, userId)
        break
      }

      case 'update_settings': {
        const settings = await saveSettings(payload.settings, userId)
        liveSettings = settings
        spindle.sendToFrontend({ type: 'settings', settings }, userId)
        break
      }

      case 'show_toast': {
        spindle.toast[payload.level](payload.message, { userId })
        break
      }

      case 'resolve_generation_target': {
        if (!spindle.permissions.has('chat_mutation')) {
          spindle.sendToFrontend({
            type: 'generation_target',
            requestId: payload.requestId,
            target: null,
            error: 'Grant the "Chat Mutation" permission to resolve chat messages.',
          }, userId)
          break
        }
        const messages = await spindle.chat.getMessages(payload.chatId) as ShutterMessage[]
        const { target: message, error } = resolveTarget(messages, payload.messageId)
        let historyEpoch = 1
        try {
          historyEpoch = (await loadHistoryState(userId)).epoch
        } catch (historyError) {
          // History corruption must not disable Shutter's core generation and
          // exact-message targeting. History operations will continue to fail
          // safely until the user clears or repairs the stored metadata.
          spindle.log.warn(`[history] Target resolved without readable history state: ${historyError instanceof Error ? historyError.message : String(historyError)}`)
        }
        spindle.sendToFrontend({
          type: 'generation_target',
          requestId: payload.requestId,
          target: message ? buildGenerationTarget(payload.chatId, message, historyEpoch) : null,
          error,
        }, userId)
        break
      }

      case 'append_generation_history': {
        const history = await appendGenerationHistory(payload.target, payload.entry, userId)
        spindle.sendToFrontend({ type: 'generation_history', requestId: payload.requestId, history }, userId)
        break
      }

      case 'get_generation_history': {
        const history = await loadGenerationHistory(payload.target, userId)
        spindle.sendToFrontend({ type: 'generation_history', requestId: payload.requestId, history }, userId)
        break
      }

      case 'get_generation_record': {
        const record = await getGenerationRecord(payload.chatId, payload.imageId, userId)
        spindle.sendToFrontend({ type: 'generation_record', requestId: payload.requestId, record }, userId)
        break
      }

      case 'clear_generation_history': {
        await clearGenerationHistory(userId)
        spindle.sendToFrontend({ type: 'history_cleared', requestId: payload.requestId }, userId)
        spindle.sendToFrontend({ type: 'generation_history_cleared' }, userId)
        break
      }

      case 'resolve_shutter_tag': {
        let imageId: string | null = null
        let path: string | null = null
        try {
          if (spindle.permissions.has('chat_mutation')) {
            const messages = await spindle.chat.getMessages(payload.chatId) as ShutterMessage[]
            const { target: message } = resolveTarget(messages, payload.messageId)
            if (message && typeof message.content === 'string') {
              const tagRe = new RegExp(String.raw`!\[shutter\]\((/api/v1/(?:images|image-gen/results)/([a-f0-9-]+))\)`, 'gi')
              const tags: Array<{ path: string; imageId: string }> = []
              let match: RegExpExecArray | null
              while ((match = tagRe.exec(message.content)) !== null) {
                tags.push({ path: match[1]!, imageId: match[2]! })
              }
              const tag = payload.index < 0
                ? (tags[tags.length + payload.index] ?? null)
                : (tags[payload.index] ?? tags[0] ?? null)
              if (tag) {
                imageId = tag.imageId
                path = tag.path
              }
            }
          }
        } catch (err) {
          spindle.log.warn(`[lightbox] resolve_shutter_tag failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        spindle.sendToFrontend({ type: 'shutter_tag', requestId: payload.requestId, imageId, path }, userId)
        break
      }

      case 'insert_into_message': {
        const reply = (
          success: boolean,
          changed: boolean,
          reason?: 'duplicate' | 'same_image' | 'target_missing' | 'permission' | 'failed',
        ): void => {
          if (!payload.requestId) return
          spindle.sendToFrontend({
            type: 'insert_result',
            requestId: payload.requestId,
            success,
            changed,
            reason,
          }, userId)
        }

        if (!spindle.permissions.has('chat_mutation')) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to insert images into messages.', { userId })
          reply(false, false, 'permission')
          break
        }

        try {
          const messages = await spindle.chat.getMessages(payload.chatId) as ShutterMessage[]
          const requestedId = payload.target?.messageId ?? payload.messageId
          const { target: message, error } = resolveTarget(messages, requestedId)
          if (!message) {
            spindle.toast.error(error || 'Message not found.', { userId })
            reply(false, false, 'target_missing')
            break
          }

          const swipeIndex = payload.target ? resolvePinnedSwipeIndex(message, payload.target) : message.swipe_id
          if (swipeIndex === null || swipeIndex < 0 || swipeIndex >= message.swipes.length) {
            spindle.toast.error('The message response used for this generation no longer exists.', { userId })
            reply(false, false, 'target_missing')
            break
          }

          const imageUrl = `/api/v1/image-gen/results/${payload.imageId}`
          let baseContent = message.swipes[swipeIndex] ?? message.content
          let didReplace = false

          // Guard before mutation so rejected replacements remain atomic.
          if (payload.replace) {
            const targetId = payload.replaceImageId
            if (targetId && !containsShutterImageId(baseContent, targetId)) {
              spindle.toast.error('The image selected for replacement is no longer in that message response.', { userId })
              reply(false, false, 'target_missing')
              break
            }
            if (targetId && targetId === payload.imageId) {
              spindle.toast.info('This image is already in that position.', { userId })
              reply(false, false, 'same_image')
              break
            }
            if (containsShutterImageId(baseContent, payload.imageId)) {
              spindle.toast.info('That image is already in this response, so nothing was replaced.', { userId })
              reply(false, false, 'duplicate')
              break
            }

            const stripped = targetId
              ? stripShutterImageById(baseContent, targetId)
              : stripLastShutterImage(baseContent)
            if (!stripped.found) {
              spindle.toast.error('The image selected for replacement is no longer in that message response.', { userId })
              reply(false, false, 'target_missing')
              break
            }
            baseContent = stripped.content
            didReplace = true
          } else if (containsShutterImageId(baseContent, payload.imageId)) {
            spindle.log.info(`[insert_into_message] skipped duplicate image insert for ${payload.imageId}`)
            spindle.toast.info('That image is already in this response.', { userId })
            reply(false, false, 'duplicate')
            break
          }

          baseContent += `

![shutter](${imageUrl})`

          const swipes = [...message.swipes]
          swipes[swipeIndex] = baseContent
          await spindle.chat.updateMessage(payload.chatId, message.id, {
            swipes,
            swipe_dates: [...message.swipe_dates],
            swipe_id: message.swipe_id,
          })

          const settings = await loadSettings(userId)
          if (settings.toastOnInsert) {
            spindle.toast.success(didReplace ? 'Image replaced.' : 'Image inserted into message.', { userId })
          }
          reply(true, true)
        } catch (err) {
          spindle.log.error(`[insert_into_message] ${err instanceof Error ? err.message : String(err)}`)
          reply(false, false, 'failed')
        }
        break
      }

      case 'delete_image': {
        if (!spindle.permissions.has('chat_mutation')) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to remove images from messages.', { userId })
          return
        }
        const messages = await spindle.chat.getMessages(payload.chatId) as ShutterMessage[]
        const { target, error } = resolveTarget(messages, payload.messageId)
        if (!target) { spindle.toast.error(error || 'Message not found.', { userId }); return }
        const stripped = stripLastShutterImage(target.content)
        if (!stripped.found) {
          spindle.toast.warning('No Shutter image found in message.', { userId })
          return
        }
        await spindle.chat.updateMessage(payload.chatId, target.id, { content: stripped.content })
        spindle.toast.success('Image removed from message.', { userId })
        break
      }

      case 'delete_all_images': {
        if (!spindle.permissions.has('chat_mutation')) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to remove images from messages.', { userId })
          return
        }
        const messages = await spindle.chat.getMessages(payload.chatId) as ShutterMessage[]
        const { target, error } = resolveTarget(messages, payload.messageId)
        if (!target) { spindle.toast.error(error || 'Message not found.', { userId }); return }
        const stripped = stripAllShutterImages(target.content)
        if (stripped.count === 0) {
          spindle.toast.warning('No Shutter images found in message.', { userId })
          return
        }
        await spindle.chat.updateMessage(payload.chatId, target.id, { content: stripped.content })
        spindle.toast.success(`Removed ${stripped.count} image${stripped.count > 1 ? 's' : ''} from message.`, { userId })
        break
      }
    }
  } catch (error) {
    const msgType = (payload && typeof payload === 'object' && 'type' in payload) ? (payload as { type: string }).type : 'unknown'
    const message = error instanceof Error ? error.message : String(error)
    spindle.log.error(`[${msgType}] ${message}`)
    const requestId = payload && typeof payload === 'object' && 'requestId' in payload
      && typeof (payload as { requestId?: unknown }).requestId === 'string'
        ? (payload as { requestId: string }).requestId
        : null
    if (requestId) {
      spindle.sendToFrontend({
        type: 'request_failed',
        requestId,
        operation: msgType,
        error: message,
      }, userId)
    }
  }
})

// ── Image-tag context interceptor ──

let imageTagInterceptorRegistered = false

function ensureImageTagInterceptor(): void {
  if (imageTagInterceptorRegistered || !spindle.permissions.has('interceptor')) return

  spindle.registerInterceptor(async (messages: LlmMessage[]) => {
    if (!liveSettings.removeImageTagsFromContext) return messages
    return messages.map(stripShutterFromLlmMessage)
  })

  imageTagInterceptorRegistered = true
  spindle.log.info('[context-tags] Image-tag interceptor registered.')
}

ensureImageTagInterceptor()

spindle.permissions.onChanged(({ permission, granted }: { permission: string; granted: boolean }) => {
  if (permission !== 'interceptor') return
  if (granted) {
    ensureImageTagInterceptor()
  } else {
    imageTagInterceptorRegistered = false
    spindle.log.warn('[context-tags] "interceptor" permission revoked; Shutter image tags will remain in context.')
  }
})

spindle.permissions.onDenied(({ permission, operation }: { permission: string; operation: string }) => {
  if (permission !== 'interceptor' || operation !== 'registerInterceptor') return
  imageTagInterceptorRegistered = false
  spindle.log.warn('[context-tags] Image-tag interceptor registration was denied.')
})

if (!spindle.permissions.has('interceptor')) {
  spindle.log.warn('[context-tags] "interceptor" permission not granted; Shutter image tags will remain in context.')
}

spindle.log.info('Shutter loaded!')
