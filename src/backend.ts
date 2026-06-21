declare const spindle: import('lumiverse-spindle-types').SpindleAPI

// ── Types ──

type Settings = {
  showFloatWidget: boolean
  toastOnInsert: boolean
  afterGenerate: 'ask_to_insert' | 'auto_insert'
  forceGeneration: boolean
  widgetSize: 'small' | 'medium' | 'large' | 'xlarge'
  widgetStyle: 'color' | 'mono'
  iconTheme: 'aperture' | 'cherry_blossom' | 'cat_lotus'
  autoGenerate: 'off' | 'every' | 'interval' | 'random'
  autoGenerateInterval: number
  autoGenerateRandomMin: number
  autoGenerateRandomMax: number
  autoGenerateAfter: 'auto_insert' | 'ask_to_insert'
  autoPreviewPrompt: boolean
  defaultAction: 'append' | 'replace'
  deleteConfirmation: 'never' | 'bulk_only' | 'always'
  removeImageTagsFromContext: boolean
}

type FrontendMessage =
  | { type: 'request_settings' }
  | { type: 'update_settings'; settings: Partial<Settings> }
  | { type: 'insert_into_message'; imageId: string; messageId: string; chatId: string; replace?: boolean }
  | { type: 'resolve_last_message_id'; requestId: string; chatId: string }
  | { type: 'delete_image'; messageId: string; chatId: string }
  | { type: 'delete_all_images'; messageId: string; chatId: string }

const DEFAULT_SETTINGS: Settings = {
  showFloatWidget: false,
  toastOnInsert: true,
  afterGenerate: 'ask_to_insert',
  forceGeneration: true,
  widgetSize: 'small',
  widgetStyle: 'color',
  iconTheme: 'aperture',
  autoGenerate: 'off',
  autoGenerateInterval: 3,
  autoGenerateRandomMin: 3,
  autoGenerateRandomMax: 7,
  autoGenerateAfter: 'auto_insert',
  autoPreviewPrompt: false,
  defaultAction: 'append',
  deleteConfirmation: 'bulk_only',
  removeImageTagsFromContext: true,
}

// Current settings used by backend features that run outside a frontend action.
let liveSettings: Settings = { ...DEFAULT_SETTINGS }

// ── Validation ──

function validateSettings(s: Settings): Settings {
  const out = { ...s }

  if (
    out.iconTheme !== 'aperture' &&
    out.iconTheme !== 'cherry_blossom' &&
    out.iconTheme !== 'cat_lotus'
  ) {
    out.iconTheme = 'aperture'
  }

  out.autoGenerateInterval = Math.max(
    1,
    Math.round(out.autoGenerateInterval),
  )
  out.autoGenerateRandomMin = Math.max(
    1,
    Math.round(out.autoGenerateRandomMin),
  )
  out.autoGenerateRandomMax = Math.max(
    out.autoGenerateRandomMin,
    Math.round(out.autoGenerateRandomMax),
  )

  return out
}

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
// Full rationale: CHANGES.md, "Message targeting".
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
          spindle.toast.warning('Grant the "Chat Mutation" permission to insert images into messages.')
          return
        }

        const messages = await spindle.chat.getMessages(payload.chatId)

        const { target, error } = resolveTarget(messages, payload.messageId)
        if (!target) { spindle.toast.error(error || 'Message not found.'); return }

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
          spindle.toast.success(didReplace ? 'Image replaced.' : 'Image inserted into message.')
        }
        break
      }

      case 'delete_image': {
        if (!spindle.permissions.has('chat_mutation')) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to remove images from messages.')
          return
        }

        const messages = await spindle.chat.getMessages(payload.chatId)

        const { target, error } = resolveTarget(messages, payload.messageId)
        if (!target) { spindle.toast.error(error || 'Message not found.'); return }

        const stripped = stripLastShutterImage(target.content)
        if (!stripped.found) {
          spindle.toast.warning('No Shutter image found in message.')
          return
        }

        await spindle.chat.updateMessage(payload.chatId, target.id, {
          content: stripped.content,
        })

        spindle.toast.success('Image removed from message.')
        break
      }

      case 'delete_all_images': {
        if (!spindle.permissions.has('chat_mutation')) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to remove images from messages.')
          return
        }

        const messages = await spindle.chat.getMessages(payload.chatId)

        const { target, error } = resolveTarget(messages, payload.messageId)
        if (!target) { spindle.toast.error(error || 'Message not found.'); return }

        const stripped = stripAllShutterImages(target.content)
        if (stripped.count === 0) {
          spindle.toast.warning('No Shutter images found in message.')
          return
        }

        await spindle.chat.updateMessage(payload.chatId, target.id, {
          content: stripped.content,
        })

        spindle.toast.success(`Removed ${stripped.count} image${stripped.count > 1 ? 's' : ''} from message.`)
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
