declare const spindle: import('lumiverse-spindle-types').SpindleAPI

import { DEFAULT_SETTINGS, validateSettings, type Settings } from './settings'
import {
  fingerprintSwipeContent,
  type GenerationHistoryInput,
  type GenerationHistoryRecord,
  type GenerationTarget,
} from './history'

// ── Types ──

type FrontendMessage =
  | { type: 'request_settings' }
  | { type: 'update_settings'; settings: Partial<Settings> }
  | { type: 'insert_into_message'; requestId?: string; imageId: string; messageId: string; chatId: string; target?: GenerationTarget; replace?: boolean; replaceImageId?: string }
  | { type: 'resolve_generation_target'; requestId: string; chatId: string; messageId: string }
  | { type: 'append_generation_history'; requestId: string; target: GenerationTarget; entry: GenerationHistoryInput }
  | { type: 'get_generation_history'; requestId: string; target: GenerationTarget }
  | { type: 'get_generation_record'; requestId: string; imageId: string }
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

const HISTORY_PREFIX = 'history/v1'
const HISTORY_STATE_PATH = `${HISTORY_PREFIX}/state.json`

type HistoryState = { version: 1; epoch: number }

type GenerationHistoryPointer = {
  version: 1
  imageId: string
  createdAt: number
  recordPath: string
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function historyEpochPrefix(epoch: number): string {
  return `${HISTORY_PREFIX}/epochs/${epoch}/`
}

function historyTargetPrefix(target: Pick<GenerationTarget, 'chatId' | 'messageId' | 'historyEpoch'>): string {
  return `${historyEpochPrefix(target.historyEpoch)}targets/${safePathSegment(target.chatId)}/${safePathSegment(target.messageId)}/`
}

function historyTargetRecordPath(record: GenerationHistoryRecord): string {
  return `${historyTargetPrefix(record.target)}${record.createdAt}-${safePathSegment(record.imageId)}.json`
}

function historyImageRecordPath(imageId: string, epoch: number): string {
  return `${historyEpochPrefix(epoch)}records/${safePathSegment(imageId)}.json`
}

async function loadHistoryState(userId?: string): Promise<HistoryState> {
  const state = await spindle.userStorage.getJson(HISTORY_STATE_PATH, {
    fallback: { version: 1, epoch: 1 } as HistoryState,
    userId,
  }) as HistoryState
  const epoch = Number.isFinite(state?.epoch) && state.epoch > 0 ? Math.floor(state.epoch) : 1
  return { version: 1, epoch }
}

function isHistoryRecord(value: unknown): value is GenerationHistoryRecord {
  const record = value as GenerationHistoryRecord | null
  return !!record
    && record.version === 1
    && typeof record.imageId === 'string'
    && typeof record.createdAt === 'number'
    && typeof record.prompt === 'string'
    && typeof record.negativePrompt === 'string'
    && typeof record.promptMode === 'string'
    && !!record.target
    && typeof record.target.chatId === 'string'
    && typeof record.target.messageId === 'string'
}

function isHistoryPointer(value: unknown): value is GenerationHistoryPointer {
  const pointer = value as GenerationHistoryPointer | null
  return !!pointer
    && pointer.version === 1
    && typeof pointer.imageId === 'string'
    && typeof pointer.createdAt === 'number'
    && typeof pointer.recordPath === 'string'
}

function recordMatchesTarget(record: GenerationHistoryRecord, target: GenerationTarget): boolean {
  if (record.target.historyEpoch !== target.historyEpoch) return false
  if (record.target.chatId !== target.chatId || record.target.messageId !== target.messageId) return false

  if (record.target.swipeDate !== null && target.swipeDate !== null) {
    if (record.target.swipeDate !== target.swipeDate) return false
    // Timestamps are normally unique. When either side observed a duplicate,
    // use the stripped-content fingerprint to avoid merging two same-second swipes.
    if (record.target.duplicateSwipeDate || target.duplicateSwipeDate) {
      return record.target.swipeFingerprint === target.swipeFingerprint
    }
    return true
  }

  return record.target.swipeId === target.swipeId
    && record.target.swipeFingerprint === target.swipeFingerprint
}

async function loadGenerationHistory(target: GenerationTarget, userId?: string): Promise<GenerationHistoryRecord[]> {
  const state = await loadHistoryState(userId)
  if (target.historyEpoch !== state.epoch) return []

  const prefix = historyTargetPrefix(target)
  const paths = await spindle.userStorage.list(prefix, userId)
  const records: GenerationHistoryRecord[] = []
  for (let offset = 0; offset < paths.length; offset += 32) {
    const batch = await Promise.all(paths.slice(offset, offset + 32).map((relativePath: string) =>
      spindle.userStorage.getJson(`${prefix}${relativePath}`, { fallback: null, userId }) as Promise<GenerationHistoryRecord | null>,
    ))
    for (const record of batch) {
      if (isHistoryRecord(record) && recordMatchesTarget(record, target)) records.push(record)
    }
  }
  records.sort((a, b) => a.createdAt - b.createdAt || a.imageId.localeCompare(b.imageId))
  return records
}

async function appendGenerationHistory(
  target: GenerationTarget,
  input: GenerationHistoryInput,
  userId?: string,
): Promise<GenerationHistoryRecord[]> {
  const settings = await loadSettings(userId)
  if (!settings.generationHistory) return []

  const stateBefore = await loadHistoryState(userId)
  if (target.historyEpoch !== stateBefore.epoch) return []

  const canonicalPath = historyImageRecordPath(input.imageId, target.historyEpoch)
  const existingPointer = await spindle.userStorage.getJson(canonicalPath, {
    fallback: null,
    userId,
  }) as GenerationHistoryPointer | null
  const existingRecord = isHistoryPointer(existingPointer)
      && existingPointer.recordPath.startsWith(historyEpochPrefix(target.historyEpoch))
    ? await spindle.userStorage.getJson(existingPointer.recordPath, { fallback: null, userId }) as GenerationHistoryRecord | null
    : null

  const record: GenerationHistoryRecord = isHistoryRecord(existingRecord)
    ? existingRecord
    : {
        version: 1,
        imageId: input.imageId,
        createdAt: Date.now(),
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        promptMode: input.promptMode,
        origin: input.origin,
        target,
      }

  const targetPath = historyTargetRecordPath(record)
  const pointer: GenerationHistoryPointer = {
    version: 1,
    imageId: record.imageId,
    createdAt: record.createdAt,
    recordPath: targetPath,
  }
  // Store the full prompt once. The image-ID index is a small pointer used by
  // Prompt View, avoiding a second copy of every potentially long prompt.
  await spindle.userStorage.setJson(targetPath, record, { indent: 2, userId })
  await spindle.userStorage.setJson(canonicalPath, pointer, { indent: 2, userId })

  // A clear can race an in-flight generation from another device. Re-check
  // the epoch after writing and remove the stale files if the clear won.
  const stateAfter = await loadHistoryState(userId)
  if (stateAfter.epoch !== target.historyEpoch) {
    await spindle.userStorage.delete(canonicalPath, userId).catch(() => {})
    await spindle.userStorage.delete(targetPath, userId).catch(() => {})
    return []
  }

  return loadGenerationHistory(target, userId)
}

async function getGenerationRecord(imageId: string, userId?: string): Promise<GenerationHistoryRecord | null> {
  const state = await loadHistoryState(userId)
  const pointer = await spindle.userStorage.getJson(historyImageRecordPath(imageId, state.epoch), {
    fallback: null,
    userId,
  }) as GenerationHistoryPointer | null
  if (!isHistoryPointer(pointer) || !pointer.recordPath.startsWith(historyEpochPrefix(state.epoch))) return null
  const record = await spindle.userStorage.getJson(pointer.recordPath, { fallback: null, userId }) as GenerationHistoryRecord | null
  return isHistoryRecord(record) && record.target.historyEpoch === state.epoch ? record : null
}

async function clearGenerationHistory(userId?: string): Promise<void> {
  const current = await loadHistoryState(userId)
  const next: HistoryState = { version: 1, epoch: current.epoch + 1 }

  // Publish the new epoch first. Any old in-flight generation now fails its
  // post-write epoch check, while a genuinely new generation writes beneath
  // the new epoch and is not swept by this clear operation.
  await spindle.userStorage.setJson(HISTORY_STATE_PATH, next, { indent: 2, userId })
  const epochsPrefix = `${HISTORY_PREFIX}/epochs/`
  const paths = await spindle.userStorage.list(epochsPrefix, userId)
  const stalePaths = paths.filter((relativePath: string) => {
    const storedEpoch = Number.parseInt(relativePath.split('/')[0] ?? '', 10)
    // Delete only epochs that existed before this clear began. A concurrent
    // clear may already have advanced the state again; its newer epoch must
    // never be swept by this operation.
    return Number.isFinite(storedEpoch) && storedEpoch <= current.epoch
  })
  for (let offset = 0; offset < stalePaths.length; offset += 32) {
    await Promise.all(stalePaths.slice(offset, offset + 32).map((relativePath: string) =>
      spindle.userStorage.delete(`${epochsPrefix}${relativePath}`, userId).catch(() => {}),
    ))
  }
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
        const state = await loadHistoryState(userId)
        spindle.sendToFrontend({
          type: 'generation_target',
          requestId: payload.requestId,
          target: message ? buildGenerationTarget(payload.chatId, message, state.epoch) : null,
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
        const record = await getGenerationRecord(payload.imageId, userId)
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
        const reply = (success: boolean, changed: boolean): void => {
          if (!payload.requestId) return
          spindle.sendToFrontend({
            type: 'insert_result',
            requestId: payload.requestId,
            success,
            changed,
          }, userId)
        }

        if (!spindle.permissions.has('chat_mutation')) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to insert images into messages.', { userId })
          reply(false, false)
          break
        }

        try {
          const messages = await spindle.chat.getMessages(payload.chatId) as ShutterMessage[]
          const requestedId = payload.target?.messageId ?? payload.messageId
          const { target: message, error } = resolveTarget(messages, requestedId)
          if (!message) {
            spindle.toast.error(error || 'Message not found.', { userId })
            reply(false, false)
            break
          }

          const swipeIndex = payload.target ? resolvePinnedSwipeIndex(message, payload.target) : message.swipe_id
          if (swipeIndex === null || swipeIndex < 0 || swipeIndex >= message.swipes.length) {
            spindle.toast.error('The message response used for this generation no longer exists.', { userId })
            reply(false, false)
            break
          }

          const imageUrl = `/api/v1/image-gen/results/${payload.imageId}`
          let baseContent = message.swipes[swipeIndex] ?? message.content
          let didReplace = false

          if (payload.replace) {
            const stripped = payload.replaceImageId
              ? stripShutterImageById(baseContent, payload.replaceImageId)
              : stripLastShutterImage(baseContent)
            if (payload.replaceImageId && !stripped.found) {
              spindle.toast.error('The image selected for replacement is no longer in that message response.', { userId })
              reply(false, false)
              break
            }
            baseContent = stripped.content
            didReplace = stripped.found
          }

          // A selected history image may already exist elsewhere in the same
          // response. In replace mode, removing the exact source image is still
          // the requested mutation, so avoid adding a duplicate. In insert mode,
          // retain the existing no-op behaviour.
          if (containsShutterImageId(baseContent, payload.imageId)) {
            if (!didReplace) {
              spindle.log.info(`[insert_into_message] skipped duplicate image insert for ${payload.imageId}`)
              reply(true, false)
              break
            }
          } else {
            baseContent += `\n\n![shutter](${imageUrl})`
          }

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
          reply(false, false)
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
  } catch (err: any) {
    const msgType = (payload && typeof payload === 'object' && 'type' in payload) ? (payload as { type: string }).type : 'unknown'
    spindle.log.error(`[${msgType}] ${err.message}`)
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
