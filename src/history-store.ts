import type { GenerationHistoryInput, GenerationHistoryRecord, GenerationTarget } from './history'

export const HISTORY_STORE_PREFIX = 'history/v1'
export const HISTORY_STATE_PATH = `${HISTORY_STORE_PREFIX}/state.json`

export type HistoryStateV1 = {
  schemaVersion: 1
  epoch: number
}

export type ChatHistorySnapshotV1 = {
  schemaVersion: 1
  epoch: number
  chatId: string
  revision: number
  createdAt: number
  updatedAt: number
  records: GenerationHistoryRecord[]
}

export type ParsedChatHistorySnapshot = {
  snapshot: ChatHistorySnapshotV1
  malformedRecordCount: number
}

export type SnapshotSlot = 'a' | 'b'

export type SnapshotCandidate = {
  slot: SnapshotSlot
  parsed: ParsedChatHistorySnapshot
}

export function encodeHistoryPathSegment(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let encoded = ''
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, '0')
  return encoded || '00'
}

export function historyEpochPrefix(epoch: number): string {
  return `${HISTORY_STORE_PREFIX}/epochs/${epoch}/`
}

export function historyChatSnapshotPath(chatId: string, epoch: number, slot: SnapshotSlot): string {
  return `${historyEpochPrefix(epoch)}chats/${encodeHistoryPathSegment(chatId)}.${slot}.json`
}

export function isHistoryStateV1(value: unknown): value is HistoryStateV1 {
  const state = value as HistoryStateV1 | null
  return !!state
    && state.schemaVersion === 1
    && Number.isInteger(state.epoch)
    && state.epoch > 0
}

export function isGenerationTarget(value: unknown): value is GenerationTarget {
  const target = value as GenerationTarget | null
  return !!target
    && typeof target.chatId === 'string'
    && target.chatId.length > 0
    && typeof target.messageId === 'string'
    && target.messageId.length > 0
    && Number.isInteger(target.swipeId)
    && target.swipeId >= 0
    && (target.swipeDate === null || (Number.isFinite(target.swipeDate) && target.swipeDate > 0))
    && typeof target.swipeFingerprint === 'string'
    && /^[a-f0-9]{8}$/i.test(target.swipeFingerprint)
    && typeof target.duplicateSwipeDate === 'boolean'
    && Number.isInteger(target.historyEpoch)
    && target.historyEpoch > 0
}

export function isGenerationHistoryRecord(value: unknown): value is GenerationHistoryRecord {
  const record = value as GenerationHistoryRecord | null
  return !!record
    && record.version === 1
    && typeof record.imageId === 'string'
    && record.imageId.length > 0
    && Number.isFinite(record.createdAt)
    && record.createdAt > 0
    && typeof record.prompt === 'string'
    && typeof record.negativePrompt === 'string'
    && typeof record.promptMode === 'string'
    && ['manual', 'auto', 'regenerate', 'rebuild', 'preview'].includes(record.origin)
    && (record.provider === undefined || typeof record.provider === 'string')
    && (record.model === undefined || typeof record.model === 'string')
    && isGenerationTarget(record.target)
}

export function parseChatHistorySnapshotV1(
  value: unknown,
  expected?: { epoch?: number; chatId?: string },
): ParsedChatHistorySnapshot | null {
  const raw = value as Partial<ChatHistorySnapshotV1> | null
  if (!raw
    || raw.schemaVersion !== 1
    || !Number.isInteger(raw.epoch)
    || (raw.epoch as number) <= 0
    || typeof raw.chatId !== 'string'
    || raw.chatId.length === 0
    || !Number.isInteger(raw.revision)
    || (raw.revision as number) < 0
    || !Number.isFinite(raw.createdAt)
    || (raw.createdAt as number) <= 0
    || !Number.isFinite(raw.updatedAt)
    || (raw.updatedAt as number) <= 0
    || (raw.updatedAt as number) < (raw.createdAt as number)
    || !Array.isArray(raw.records)
  ) return null

  if (expected?.epoch !== undefined && raw.epoch !== expected.epoch) return null
  if (expected?.chatId !== undefined && raw.chatId !== expected.chatId) return null

  const records: GenerationHistoryRecord[] = []
  const imageIds = new Set<string>()
  let malformedRecordCount = 0
  for (const value of raw.records) {
    if (isGenerationHistoryRecord(value)
      && value.target.chatId === raw.chatId
      && value.target.historyEpoch === raw.epoch
      && !imageIds.has(value.imageId)
    ) {
      imageIds.add(value.imageId)
      records.push(value)
    } else {
      malformedRecordCount++
    }
  }

  return {
    snapshot: {
      schemaVersion: 1,
      epoch: raw.epoch as number,
      chatId: raw.chatId as string,
      revision: raw.revision as number,
      createdAt: raw.createdAt as number,
      updatedAt: raw.updatedAt as number,
      records,
    },
    malformedRecordCount,
  }
}

export function selectNewestSnapshot(candidates: SnapshotCandidate[]): SnapshotCandidate | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((left, right) =>
    right.parsed.snapshot.revision - left.parsed.snapshot.revision
    || right.parsed.snapshot.updatedAt - left.parsed.snapshot.updatedAt
    || left.slot.localeCompare(right.slot)
  )[0] ?? null
}

export function recordMatchesTarget(record: GenerationHistoryRecord, target: GenerationTarget): boolean {
  if (record.target.historyEpoch !== target.historyEpoch) return false
  if (record.target.chatId !== target.chatId || record.target.messageId !== target.messageId) return false

  if (record.target.swipeDate !== null && target.swipeDate !== null) {
    if (record.target.swipeDate !== target.swipeDate) return false
    if (record.target.duplicateSwipeDate || target.duplicateSwipeDate) {
      return record.target.swipeFingerprint === target.swipeFingerprint
    }
    return true
  }

  return record.target.swipeId === target.swipeId
    && record.target.swipeFingerprint === target.swipeFingerprint
}

function optionalEqual(left?: string, right?: string): boolean {
  return (left ?? '') === (right ?? '')
}

export function historyRecordsEquivalent(
  left: GenerationHistoryRecord,
  right: GenerationHistoryRecord,
): boolean {
  return left.version === right.version
    && left.imageId === right.imageId
    && left.createdAt === right.createdAt
    && left.prompt === right.prompt
    && left.negativePrompt === right.negativePrompt
    && left.promptMode === right.promptMode
    && left.origin === right.origin
    && optionalEqual(left.provider, right.provider)
    && optionalEqual(left.model, right.model)
    && left.target.chatId === right.target.chatId
    && left.target.messageId === right.target.messageId
    && left.target.swipeId === right.target.swipeId
    && left.target.swipeDate === right.target.swipeDate
    && left.target.swipeFingerprint === right.target.swipeFingerprint
    && left.target.duplicateSwipeDate === right.target.duplicateSwipeDate
    && left.target.historyEpoch === right.target.historyEpoch
}

export function recordMatchesInput(
  record: GenerationHistoryRecord,
  target: GenerationTarget,
  input: GenerationHistoryInput,
): boolean {
  return record.imageId === input.imageId
    && record.prompt === input.prompt
    && record.negativePrompt === input.negativePrompt
    && record.promptMode === input.promptMode
    && record.origin === input.origin
    && optionalEqual(record.provider, input.provider)
    && optionalEqual(record.model, input.model)
    && record.target.chatId === target.chatId
    && record.target.messageId === target.messageId
    && record.target.swipeId === target.swipeId
    && record.target.swipeDate === target.swipeDate
    && record.target.swipeFingerprint === target.swipeFingerprint
    && record.target.duplicateSwipeDate === target.duplicateSwipeDate
    && record.target.historyEpoch === target.historyEpoch
}

export function createHistoryRecord(
  target: GenerationTarget,
  input: GenerationHistoryInput,
  createdAt = Date.now(),
): GenerationHistoryRecord {
  return {
    version: 1,
    imageId: input.imageId,
    createdAt,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    promptMode: input.promptMode,
    origin: input.origin,
    provider: input.provider,
    model: input.model,
    target,
  }
}

export function createChatSnapshot(
  chatId: string,
  epoch: number,
  records: GenerationHistoryRecord[],
  revision = records.length > 0 ? 1 : 0,
  timestamp = Date.now(),
): ChatHistorySnapshotV1 {
  return {
    schemaVersion: 1,
    epoch,
    chatId,
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
    records: [...records],
  }
}

export function appendRecordToSnapshot(
  current: ChatHistorySnapshotV1 | null,
  record: GenerationHistoryRecord,
  timestamp = Date.now(),
): ChatHistorySnapshotV1 {
  if (!current) return createChatSnapshot(record.target.chatId, record.target.historyEpoch, [record], 1, timestamp)
  return {
    ...current,
    revision: current.revision + 1,
    updatedAt: timestamp,
    records: [...current.records, record],
  }
}
