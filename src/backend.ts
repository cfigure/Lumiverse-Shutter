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
  const saved = await spindle.userStorage.getJson<Partial<Settings>>('settings.json', { fallback: {}, userId })
  return { ...DEFAULT_SETTINGS, ...saved }
}

async function saveSettings(patch: Partial<Settings>, userId?: string): Promise<Settings> {
  const current = await loadSettings(userId)
  const merged = validateSettings({ ...current, ...patch })
  await spindle.userStorage.setJson('settings.json', merged, { indent: 2, userId })
  return merged
}

// ── Frontend messages ──

spindle.onFrontendMessage(async (payload: FrontendMessage, userId) => {
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

      case 'insert_into_message': {
        if (!spindle.permissions.has('chat_mutation')) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to insert images into messages.')
          return
        }

        const messages = await spindle.chat.getMessages(payload.chatId)

        let targetId = payload.messageId
        if (targetId === '__last__') {
          const last = messages[messages.length - 1]
          if (!last) { spindle.toast.error('No messages in chat.'); return }
          targetId = last.id
        }

        const target = messages.find(m => m.id === targetId)
        if (!target) { spindle.toast.error('Message not found.'); return }

        const imageUrl = `/api/v1/image-gen/results/${payload.imageId}`
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
