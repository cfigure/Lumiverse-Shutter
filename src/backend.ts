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
}

type FrontendMessage =
  | { type: 'request_settings' }
  | { type: 'update_settings'; settings: Partial<Settings> }
  | { type: 'insert_into_message'; imageId: string; messageId: string; chatId: string }
  | { type: 'resolve_last_message_id'; requestId: string; chatId: string }

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

// ── Frontend messages ──

spindle.onFrontendMessage(async (payload: FrontendMessage, userId?: string) => {
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

        const messages = await spindle.chat.getMessages(payload.chatId) as Array<{
          id?: string
          createdAt?: string
          created_at?: string
          timestamp?: string
        }>

        const valid = Array.isArray(messages) ? messages.filter(m => typeof m?.id === 'string') : []
        const sortable = valid.every(m => {
          const raw = m.createdAt || m.created_at || m.timestamp
          return typeof raw === 'string' && !Number.isNaN(Date.parse(raw))
        })
        const ordered = sortable
          ? [...valid].sort((a, b) => {
              const at = Date.parse(a.createdAt || a.created_at || a.timestamp || '')
              const bt = Date.parse(b.createdAt || b.created_at || b.timestamp || '')
              return at - bt
            })
          : valid
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

        const messages = await spindle.chat.getMessages(payload.chatId) as Array<{ id: string; content: string }>

        let targetId = payload.messageId
        if (targetId === '__last__') {
          const last = messages[messages.length - 1]
          if (!last) { spindle.toast.error('No messages in chat.'); return }
          targetId = last.id
        }

        const target = messages.find(m => m.id === targetId)
        if (!target) { spindle.toast.error('Message not found.'); return }

        const imageUrl = `/api/v1/image-gen/results/${payload.imageId}`
        if (target.content.includes(imageUrl)) {
          spindle.log.info(`[insert_into_message] skipped duplicate image insert for ${payload.imageId}`)
          return
        }

        await spindle.chat.updateMessage(payload.chatId, targetId, {
          content: target.content + `\n\n![shutter](${imageUrl})`,
        })

        const settings = await loadSettings(userId)
        if (settings.toastOnInsert) {
          spindle.toast.success('Image inserted into message.')
        }
        break
      }
    }
  } catch (err: any) {
    spindle.log.error(`[${payload.type}] ${err.message}`)
  }
})

spindle.log.info('Shutter loaded!')
