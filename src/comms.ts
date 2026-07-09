// Spindle message-channel round-trips: request/response pairs over
// ctx.sendToBackend / ctx.onBackendMessage, correlated by requestId with a
// timeout fallback. This is the plumbing seam shared by the lightbox prompt
// label, the View Prompt modal, and callImageGen's attach-target resolution —
// it lives here (not in any one feature module) so no feature falsely owns it.
//
// The entry file owns the single ctx.onBackendMessage subscription and calls
// handleBackendMessage first; payloads it consumes (the round-trip replies)
// return true, everything else (e.g. 'settings') falls through to the entry's
// own handling.

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ShutterTag } from './metadata'

export type Comms = ReturnType<typeof createComms>

export function createComms(ctx: SpindleFrontendContext) {
  const pendingLastMessageRequests = new Map<string, { resolve: (value: string | undefined) => void; timeout: ReturnType<typeof setTimeout> }>()
  const pendingTagRequests = new Map<string, { resolve: (t: ShutterTag | null) => void; timeout: ReturnType<typeof setTimeout> }>()

  async function resolveLastMessageId(chatId: string): Promise<string | undefined> {
    const requestId = `last-message-${Date.now()}-${Math.random().toString(36).slice(2)}`

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingLastMessageRequests.delete(requestId)
        resolve(undefined)
      }, 5000)

      pendingLastMessageRequests.set(requestId, { resolve, timeout })
      ctx.sendToBackend({ type: 'resolve_last_message_id', requestId, chatId })
    })
  }

  function resolveShutterTag(chatId: string, messageId: string, index: number): Promise<ShutterTag | null> {
    const requestId = `shutter-tag-${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingTagRequests.delete(requestId)
        resolve(null)
      }, 4000)
      pendingTagRequests.set(requestId, { resolve, timeout })
      ctx.sendToBackend({ type: 'resolve_shutter_tag', requestId, chatId, messageId, index })
    })
  }

  // Returns true when the payload was a comms round-trip reply (consumed).
  function handleBackendMessage(payload: any): boolean {
    if (payload.type === 'last_message_id') {
      const pending = pendingLastMessageRequests.get(payload.requestId)
      if (!pending) return true
      clearTimeout(pending.timeout)
      pendingLastMessageRequests.delete(payload.requestId)
      pending.resolve(typeof payload.messageId === 'string' ? payload.messageId : undefined)
      return true
    }

    if (payload.type === 'shutter_tag') {
      const pending = pendingTagRequests.get(payload.requestId)
      if (!pending) return true
      clearTimeout(pending.timeout)
      pendingTagRequests.delete(payload.requestId)
      pending.resolve(payload.imageId && payload.path ? { imageId: payload.imageId, path: payload.path } : null)
      return true
    }

    return false
  }

  // Teardown mirrors the original cleanup exactly: tag requests only have
  // their timeouts cleared (their promises are abandoned with the session),
  // while last-message requests are resolved undefined so any await in a
  // still-running callImageGen can complete.
  function dispose(): void {
    for (const [, pending] of pendingTagRequests) {
      clearTimeout(pending.timeout)
    }
    pendingTagRequests.clear()
    for (const [requestId, pending] of pendingLastMessageRequests) {
      clearTimeout(pending.timeout)
      pending.resolve(undefined)
      pendingLastMessageRequests.delete(requestId)
    }
  }

  return { resolveLastMessageId, resolveShutterTag, handleBackendMessage, dispose }
}
