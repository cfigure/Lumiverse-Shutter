declare const spindle: import('lumiverse-spindle-types').SpindleAPI

import { DEFAULT_SETTINGS, validateSettings, type Settings } from './settings'

// ── Types ──

type FrontendMessage =
  | { type: 'request_settings' }
  | { type: 'update_settings'; settings: Partial<Settings> }
  | { type: 'insert_into_message'; imageId: string; messageId: string; chatId: string; replace?: boolean }
  | { type: 'resolve_last_message_id'; requestId: string; chatId: string }
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

function stripAllShutterImages(content: string): { content: string; count: number } {
  let count = 0
  const stripped = content.replace(SHUTTER_IMAGE_GLOBAL_RE, () => { count++; return '' })
  return { content: stripped, count }
}

// ── Image-tag context filtering (interceptor) ──
//
// Mirrors the legacy Shutter regex (target:prompt, ai_output): strip the
// inline ![shutter](...) markdown from the assembled prompt so the model
// never sees it, while the stored/displayed message keeps the image. Handles
// both LlmMessageDTO content shapes — a plain string, or a parts array where
// only text parts carry the markdown.

type LlmMessage = import('lumiverse-spindle-types').LlmMessageDTO

function stripShutterFromLlmMessage(message: LlmMessage): LlmMessage {
  const { content } = message
  if (typeof content === 'string') {
    return { ...message, content: content.replace(SHUTTER_IMAGE_GLOBAL_RE, '') }
  }
  return {
    ...message,
    content: content.map(part =>
      part.type === 'text'
        ? { ...part, text: part.text.replace(SHUTTER_IMAGE_GLOBAL_RE, '') }
        : part,
    ),
  }
}

// ── Message resolution ──
//
// '__last__' = the literal newest message, any role, resolved at execution
// time. Deliberate: do NOT retarget this to the last AI message. That was
// tried and reverted. Last-AI lets Remove/Replace reach past a trailing
// user message or a deletion and silently strip an older reply's image
// (destructive, invisible). Literal-last's worst case is an image landing
// on the user's own queued message (additive, visible, reversible).
// Matches native ImageGen's attach-to-last (messages[length - 1]).
type ShutterMessage = { id: string; content: string; role: string; index_in_chat: number }

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
        // Toasts are backend-only in the Spindle API (free tier, no
        // permission), so the frontend routes its notifications through
        // here — same pattern as insert confirmations. `userId` targets the
        // sender: operator-scoped installs (Lumiverse's default for GitHub
        // installs) broadcast to ALL users when it is omitted; user-scoped
        // installs ignore it. Same option on every toast in this handler.
        spindle.toast[payload.level](payload.message, { userId })
        break
      }

      case 'resolve_shutter_tag': {
        // Resolve the authoritative image identity for a Shutter image from
        // the message markdown itself. Rendered/lightbox srcs can't be
        // trusted: host builds may rewrite them to separate display records
        // and thumbnail tiers, but the ![shutter](...) tag always carries
        // the generation image ID and the original route (which serves
        // unmodified provider bytes for metadata parsing). messageId
        // supports '__last__' (same semantics as the mutation handlers) and
        // a negative index counts from the end (-1 = newest tag) — used by
        // the widget menu's View Prompt, which targets the last Shutter
        // image of the last message without needing the rendered DOM.
        let imageId: string | null = null
        let path: string | null = null
        try {
          if (spindle.permissions.has('chat_mutation')) {
            const messages = await spindle.chat.getMessages(payload.chatId)
            const { target: message } = resolveTarget(messages, payload.messageId)
            if (message && typeof message.content === 'string') {
              const tagRe = new RegExp(String.raw`!\[shutter\]\((/api/v1/(?:images|image-gen/results)/([a-f0-9-]+))\)`, 'gi')
              const tags: Array<{ path: string; imageId: string }> = []
              let m: RegExpExecArray | null
              while ((m = tagRe.exec(message.content)) !== null) {
                tags.push({ path: m[1], imageId: m[2] })
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
        spindle.sendToFrontend({
          type: 'shutter_tag',
          requestId: payload.requestId,
          imageId,
          path,
        }, userId)
        break
      }

      case 'resolve_last_message_id': {
        if (!spindle.permissions.has('chat_mutation')) {
          spindle.sendToFrontend({
            type: 'last_message_id',
            requestId: payload.requestId,
            messageId: null,
            error: 'Grant the "Chat Mutation" permission to resolve chat messages.',
          }, userId)
          return
        }
        
        // Mirror native ImageGen's attach_to_message semantics: the literal
        // last message in the chat, regardless of role (ImageGenPanel does
        // messages[messages.length - 1] at click time).
        const messages = await spindle.chat.getMessages(payload.chatId)
        const ordered = orderedMessages(messages)
        const last = ordered[ordered.length - 1]

        spindle.sendToFrontend({
          type: 'last_message_id',
          requestId: payload.requestId,
          messageId: last?.id ?? null,
        }, userId)
        break
      }

      case 'insert_into_message': {
        if (!spindle.permissions.has('chat_mutation')) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to insert images into messages.', { userId })
          return
        }

        const messages = await spindle.chat.getMessages(payload.chatId)

        const { target, error } = resolveTarget(messages, payload.messageId)
        if (!target) { spindle.toast.error(error || 'Message not found.', { userId }); return }

        const imageUrl = `/api/v1/image-gen/results/${payload.imageId}`
        if (target.content.includes(imageUrl)) {
          spindle.log.info(`[insert_into_message] skipped duplicate image insert for ${payload.imageId}`)
          return
        }

        let baseContent = target.content
        let didReplace = false
        if (payload.replace) {
          const stripped = stripLastShutterImage(baseContent)
          baseContent = stripped.content
          didReplace = stripped.found
        }

        await spindle.chat.updateMessage(payload.chatId, target.id, {
          content: baseContent + `\n\n![shutter](${imageUrl})`,
        })

        const settings = await loadSettings(userId)
        if (settings.toastOnInsert) {
          spindle.toast.success(didReplace ? 'Image replaced.' : 'Image inserted into message.', { userId })
        }
        break
      }

      case 'delete_image': {
        if (!spindle.permissions.has('chat_mutation')) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to remove images from messages.', { userId })
          return
        }

        const messages = await spindle.chat.getMessages(payload.chatId)

        const { target, error } = resolveTarget(messages, payload.messageId)
        if (!target) { spindle.toast.error(error || 'Message not found.', { userId }); return }

        const stripped = stripLastShutterImage(target.content)
        if (!stripped.found) {
          spindle.toast.warning('No Shutter image found in message.', { userId })
          return
        }

        await spindle.chat.updateMessage(payload.chatId, target.id, {
          content: stripped.content,
        })

        spindle.toast.success('Image removed from message.', { userId })
        break
      }

      case 'delete_all_images': {
        if (!spindle.permissions.has('chat_mutation')) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to remove images from messages.', { userId })
          return
        }

        const messages = await spindle.chat.getMessages(payload.chatId)

        const { target, error } = resolveTarget(messages, payload.messageId)
        if (!target) { spindle.toast.error(error || 'Message not found.', { userId }); return }

        const stripped = stripAllShutterImages(target.content)
        if (stripped.count === 0) {
          spindle.toast.warning('No Shutter images found in message.', { userId })
          return
        }

        await spindle.chat.updateMessage(payload.chatId, target.id, {
          content: stripped.content,
        })

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
//
// Registered once at startup. Reads the live setting on every generation so
// toggling 'Remove Image Tags from Context' takes effect on the next
// message with no re-registration (the host exposes a single interceptor slot
// per extension and no unregister handle to the sandbox). When enabled, strip
// Shutter's inline image tags; when disabled, pass the prompt through untouched.
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

spindle.permissions.onChanged(({ permission, granted }) => {
  if (permission !== 'interceptor') return
  if (granted) {
    ensureImageTagInterceptor()
  } else {
    imageTagInterceptorRegistered = false
    spindle.log.warn('[context-tags] "interceptor" permission revoked; Shutter image tags will remain in context.')
  }
})

spindle.permissions.onDenied(({ permission, operation }) => {
  if (permission !== 'interceptor' || operation !== 'registerInterceptor') return
  imageTagInterceptorRegistered = false
  spindle.log.warn('[context-tags] Image-tag interceptor registration was denied.')
})

if (!spindle.permissions.has('interceptor')) {
  spindle.log.warn('[context-tags] "interceptor" permission not granted; Shutter image tags will remain in context.')
}

spindle.log.info('Shutter loaded!')
