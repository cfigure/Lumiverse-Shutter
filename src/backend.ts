declare const spindle: import('lumiverse-spindle-types').SpindleAPI

// ── Types ──

type Settings = {
  showFloatWidget: boolean
  toastOnInsert: boolean
  afterGenerate: 'ask_to_insert' | 'auto_insert'
  forceGeneration: boolean
  widgetSize: 'small' | 'medium' | 'large'
  widgetStyle: 'color' | 'mono'
  autoGenerate: 'off' | 'every' | 'interval' | 'random'
  autoGenerateInterval: number
  autoGenerateRandomMin: number
  autoGenerateRandomMax: number
  autoGenerateAfter: 'auto_insert' | 'ask_to_insert'
  autoPreviewPrompt: boolean
  defaultAction: 'append' | 'replace'
  deleteConfirmation: 'never' | 'bulk_only' | 'always'
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
  autoGenerate: 'off',
  autoGenerateInterval: 3,
  autoGenerateRandomMin: 3,
  autoGenerateRandomMax: 7,
  autoGenerateAfter: 'auto_insert',
  autoPreviewPrompt: false,
  defaultAction: 'append',
  deleteConfirmation: 'bulk_only',
}

// ── Validation ──

function validateSettings(s: Settings): Settings {
  const out = { ...s }
  out.autoGenerateInterval = Math.max(1, Math.round(out.autoGenerateInterval))
  out.autoGenerateRandomMin = Math.max(1, Math.round(out.autoGenerateRandomMin))
  out.autoGenerateRandomMax = Math.max(out.autoGenerateRandomMin, Math.round(out.autoGenerateRandomMax))
  return out
}

// ── Storage ──

async function loadSettings(userId?: string): Promise<Settings> {
  const saved = await spindle.userStorage.getJson('settings.json', { fallback: {}, userId }) as Partial<Settings>
  return { ...DEFAULT_SETTINGS, ...saved }
}

async function saveSettings(patch: Partial<Settings>, userId?: string): Promise<Settings> {
  const current = await loadSettings(userId)
  const merged = validateSettings({ ...current, ...patch })
  await spindle.userStorage.setJson('settings.json', merged, { indent: 2, userId })
  return merged
}

// ── Image manipulation ──
// Keep in sync with Shutter-regex-scripts.json, which uses this same
// pattern (unanchored, 'gi') to strip these tags from the LLM prompt.

const SHUTTER_IMAGE_SOURCE = String.raw`\n{0,2}!\[shutter\]\(/api/v1/(?:images|image-gen/results)/[a-f0-9-]+\)`
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
        spindle.sendToFrontend({ type: 'settings', settings }, userId)
        break
      }

      case 'update_settings': {
        const settings = await saveSettings(payload.settings, userId)
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

spindle.log.info('Shutter loaded!')
