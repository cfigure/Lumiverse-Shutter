// Spindle message-channel round-trips, correlated by requestId with timeout
// fallbacks. The entry owns the single ctx.onBackendMessage subscription.

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ShutterTag } from './metadata'
import type {
  GenerationHistoryInput,
  GenerationHistoryRecord,
  GenerationTarget,
} from './history'

export type Comms = ReturnType<typeof createComms>

type PendingRequest = {
  kind: 'target' | 'tag' | 'history' | 'record' | 'clear' | 'insert'
  resolve: (value: any) => void
  fallback: unknown
  timeout: ReturnType<typeof setTimeout>
}

export function createComms(ctx: SpindleFrontendContext) {
  const pending = new Map<string, PendingRequest>()

  function request<T>(
    kind: PendingRequest['kind'],
    type: string,
    payload: Record<string, unknown>,
    fallback: T,
    timeoutMs = 5000,
  ): Promise<T> {
    const requestId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId)
        resolve(fallback)
      }, timeoutMs)
      pending.set(requestId, { kind, resolve, fallback, timeout })
      ctx.sendToBackend({ type, requestId, ...payload })
    })
  }

  function resolveGenerationTarget(chatId: string, messageId: string): Promise<GenerationTarget | null> {
    return request('target', 'resolve_generation_target', { chatId, messageId }, null)
  }

  function resolveShutterTag(chatId: string, messageId: string, index: number): Promise<ShutterTag | null> {
    return request('tag', 'resolve_shutter_tag', { chatId, messageId, index }, null, 4000)
  }

  function appendGenerationHistory(
    target: GenerationTarget,
    entry: GenerationHistoryInput,
  ): Promise<GenerationHistoryRecord[]> {
    return request('history', 'append_generation_history', { target, entry }, [])
  }

  function getGenerationHistory(target: GenerationTarget): Promise<GenerationHistoryRecord[]> {
    return request('history', 'get_generation_history', { target }, [])
  }

  function getGenerationRecord(chatId: string, imageId: string): Promise<GenerationHistoryRecord | null> {
    return request('record', 'get_generation_record', { chatId, imageId }, null)
  }

  function clearGenerationHistory(): Promise<boolean> {
    return request('clear', 'clear_generation_history', {}, false, 15000)
  }

  function insertIntoMessage(payload: {
    imageId: string
    messageId: string
    chatId: string
    target?: GenerationTarget
    replace?: boolean
    replaceImageId?: string
  }): Promise<{
    success: boolean
    changed: boolean
    reason?: 'duplicate' | 'same_image' | 'target_missing' | 'permission' | 'failed'
  }> {
    return request('insert', 'insert_into_message', payload, { success: false, changed: false, reason: 'failed' }, 15000)
  }

  // Returns true when the payload was a comms round-trip reply (consumed).
  function handleBackendMessage(payload: any): boolean {
    if (!payload || typeof payload.requestId !== 'string') return false
    const entry = pending.get(payload.requestId)
    if (!entry) return false

    if (payload.type === 'request_failed') {
      clearTimeout(entry.timeout)
      pending.delete(payload.requestId)
      console.warn(`[Shutter] ${typeof payload.operation === 'string' ? payload.operation : 'request'} failed: ${typeof payload.error === 'string' ? payload.error : 'Unknown backend error'}`)
      entry.resolve(entry.fallback)
      return true
    }

    const matches =
      (payload.type === 'generation_target' && entry.kind === 'target')
      || (payload.type === 'shutter_tag' && entry.kind === 'tag')
      || (payload.type === 'generation_history' && entry.kind === 'history')
      || (payload.type === 'generation_record' && entry.kind === 'record')
      || (payload.type === 'history_cleared' && entry.kind === 'clear')
      || (payload.type === 'insert_result' && entry.kind === 'insert')
    if (!matches) return false

    clearTimeout(entry.timeout)
    pending.delete(payload.requestId)

    if (payload.type === 'generation_target') {
      entry.resolve(payload.target ?? null)
    } else if (payload.type === 'shutter_tag') {
      entry.resolve(payload.imageId && payload.path ? { imageId: payload.imageId, path: payload.path } : null)
    } else if (payload.type === 'generation_history') {
      entry.resolve(Array.isArray(payload.history) ? payload.history : [])
    } else if (payload.type === 'generation_record') {
      entry.resolve(payload.record ?? null)
    } else if (payload.type === 'insert_result') {
      entry.resolve({ success: payload.success === true, changed: payload.changed === true, reason: payload.reason })
    } else {
      entry.resolve(true)
    }
    return true
  }

  function dispose(): void {
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timeout)
      if (entry.kind === 'history') entry.resolve([])
      else if (entry.kind === 'clear') entry.resolve(false)
      else if (entry.kind === 'insert') entry.resolve({ success: false, changed: false, reason: 'failed' })
      else entry.resolve(null)
      pending.delete(requestId)
    }
  }

  return {
    resolveGenerationTarget,
    resolveShutterTag,
    appendGenerationHistory,
    getGenerationHistory,
    getGenerationRecord,
    clearGenerationHistory,
    insertIntoMessage,
    handleBackendMessage,
    dispose,
  }
}
