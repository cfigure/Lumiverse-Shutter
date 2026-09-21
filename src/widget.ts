import type {
  SpindleFrontendContext,
  SpindleFrontendWidgetTarget,
} from 'lumiverse-spindle-types'
import { createComms } from './comms'
import { mountShutterFloatWidget } from './float-widget'
import type {
  GenerationHistoryRecord,
  GenerationOrigin,
  GenerationTarget,
} from './history'
import {
  createNativeImageGen,
  parseErrorMessage,
  type GenerationResult,
} from './native-image-gen'
import { createModals } from './modals'
import { DEFAULT_SETTINGS, type Settings } from './settings'
import { SHUTTER_CSS } from './styles'

// Dedicated Lumiverse Desktop pop-out entry. This intentionally starts only
// the widget workflow: no settings panel, input-bar action, lightbox hooks, or
// GENERATION_ENDED auto-generation listener.
export function setupWidget(
  ctx: SpindleFrontendContext,
  target: SpindleFrontendWidgetTarget,
) {
  let settings: Settings = { ...DEFAULT_SETTINGS }
  let generating = false
  let activeChatId = ctx.getActiveChat()?.chatId ?? null
  const comms = createComms(ctx)
  const { fetchNativeSettings, callImageGen, callPreviewPrompt } = createNativeImageGen()
  const removeStyle = ctx.dom.addStyle(SHUTTER_CSS)

  async function refreshActiveChatId(): Promise<string | null> {
    const liveChatId = ctx.getActiveChat()?.chatId
    if (liveChatId) {
      activeChatId = liveChatId
      return activeChatId
    }

    try {
      const response = await fetch('/api/v1/settings/activeChatId')
      if (response.ok) {
        const stored = await response.json()
        activeChatId = typeof stored?.value === 'string' && stored.value ? stored.value : null
      }
    } catch { /* retain the last known chat */ }
    return activeChatId
  }

  function setGeneratingState(active: boolean): void {
    generating = active
    widget.setGenerating(active)
  }

  function notifyGenerationSkipped(reason: string): void {
    ctx.sendToBackend({ type: 'show_toast', level: 'info', message: `${reason} — generation skipped.` })
  }

  async function handleGenerationResult(
    result: GenerationResult,
    generationTarget: GenerationTarget,
    isAuto: boolean,
    replace = false,
    origin: GenerationOrigin = isAuto ? 'auto' : 'manual',
  ): Promise<void> {
    setGeneratingState(false)
    if (result.handledByNative) return

    let history: GenerationHistoryRecord[] = []
    if (settings.generationHistory) {
      history = await comms.appendGenerationHistory(generationTarget, {
        imageId: result.imageId,
        prompt: result.prompt,
        negativePrompt: result.negativePrompt,
        promptMode: result.promptMode,
        origin,
        provider: result.provider,
        model: result.model,
      })
    }

    const afterAction = isAuto ? settings.autoGenerateAfter : settings.afterGenerate
    if (afterAction === 'auto_insert') {
      ctx.sendToBackend({
        type: 'insert_into_message',
        imageId: result.imageId,
        messageId: generationTarget.messageId,
        chatId: generationTarget.chatId,
        target: generationTarget,
        replace,
      })
    } else {
      modals.openDestinationModal(result, generationTarget, isAuto, replace, history)
    }
  }

  async function triggerGenerate(
    messageId?: string,
    chatId?: string,
    isAuto = false,
    replace = false,
    force = false,
    pinnedTarget?: GenerationTarget,
    origin: GenerationOrigin = isAuto ? 'auto' : 'manual',
  ): Promise<void> {
    if (generating || modals.isPromptPreviewOpen()) return
    chatId = chatId || await refreshActiveChatId() || undefined
    if (!chatId) return

    setGeneratingState(true)
    try {
      const generationTarget = pinnedTarget
        ?? await comms.resolveGenerationTarget(chatId, messageId || '__last__')
      if (!generationTarget) throw new Error('No message response is available for this generation.')

      const native = await fetchNativeSettings()
      const outputTarget = native.outputTarget || 'background'
      if (isAuto && (outputTarget === 'chat_attachment' || outputTarget === 'attach_to_message')) {
        setGeneratingState(false)
        return
      }

      const showPreview = native.previewPromptBeforeGenerate
        && (!isAuto || settings.autoPreviewPrompt)
      if (showPreview) {
        const preview = await callPreviewPrompt(chatId)
        setGeneratingState(false)
        modals.openPromptPreviewModal(
          preview.prompt,
          preview.negativePrompt,
          generationTarget,
          isAuto,
          replace,
          origin,
        )
        return
      }

      const result = await callImageGen(
        chatId,
        force ? { forceGeneration: true } : undefined,
        generationTarget,
      )
      if ('skipped' in result) {
        setGeneratingState(false)
        if (!isAuto) notifyGenerationSkipped(result.reason)
        return
      }
      await handleGenerationResult(result, generationTarget, isAuto, replace, origin)
    } catch (err: any) {
      setGeneratingState(false)
      if (!isAuto) modals.showErrorModal(parseErrorMessage(err?.message || String(err)))
    }
  }

  async function deleteImage(): Promise<void> {
    const chatId = await refreshActiveChatId()
    if (!chatId) return
    if (settings.deleteConfirmation === 'always') {
      const { confirmed } = await ctx.ui.showConfirm({
        title: 'Remove Image',
        message: 'Remove the last Shutter image from the last message?',
        variant: 'danger',
        confirmLabel: 'Remove',
      })
      if (!confirmed) return
    }
    ctx.sendToBackend({ type: 'delete_image', messageId: '__last__', chatId })
  }

  async function deleteAllImages(): Promise<void> {
    const chatId = await refreshActiveChatId()
    if (!chatId) return
    if (settings.deleteConfirmation !== 'never') {
      const { confirmed } = await ctx.ui.showConfirm({
        title: 'Remove All Images',
        message: 'Remove all Shutter images from the last message? This cannot be undone.',
        variant: 'danger',
        confirmLabel: 'Remove All',
      })
      if (!confirmed) return
    }
    ctx.sendToBackend({ type: 'delete_all_images', messageId: '__last__', chatId })
  }

  async function showWidgetMenu(x: number, y: number): Promise<void> {
    if (generating) return

    let showForce = true
    try {
      const native = await fetchNativeSettings()
      showForce = (native.promptMode || 'scene') === 'scene' && !native.forceGeneration
    } catch { /* keep Force Generate available */ }

    const { selectedKey } = await ctx.ui.showContextMenu({
      position: { x, y },
      items: [
        { key: '_header', label: 'Last Message', disabled: true },
        { key: 'div0', label: '', type: 'divider' },
        { key: 'append', label: 'Append' },
        { key: 'replace', label: 'Replace' },
        ...(showForce ? [{ key: 'force', label: 'Force Generate' }] : []),
        { key: 'div_vp', label: '', type: 'divider' },
        ...(settings.generationHistory ? [{ key: 'insert', label: 'Insert' }] : []),
        { key: 'view_prompt', label: 'View Prompt' },
        { key: 'div1', label: '', type: 'divider' },
        { key: 'delete', label: 'Remove', danger: true },
        { key: 'delete_all', label: 'Remove All', danger: true },
      ],
    })

    if (selectedKey === 'append') void triggerGenerate()
    else if (selectedKey === 'replace') void triggerGenerate(undefined, undefined, false, true)
    else if (selectedKey === 'force') void triggerGenerate(undefined, undefined, false, settings.defaultAction === 'replace', true)
    else if (selectedKey === 'insert') {
      const chatId = await refreshActiveChatId()
      if (!chatId) return
      const [generationTarget, currentTag] = await Promise.all([
        comms.resolveGenerationTarget(chatId, '__last__'),
        comms.resolveShutterTag(chatId, '__last__', -1),
      ])
      const history = generationTarget ? await comms.getGenerationHistory(generationTarget) : []
      if (history.length === 0) {
        ctx.sendToBackend({
          type: 'show_toast',
          level: 'info',
          message: 'No generation history is available for the last message.',
        })
        return
      }
      const newest = history.reduce((latest, entry) =>
        entry.createdAt > latest.createdAt
          || (entry.createdAt === latest.createdAt && entry.imageId.localeCompare(latest.imageId) > 0)
          ? entry
          : latest,
      )
      const initialImageId = currentTag && history.some(entry => entry.imageId === currentTag.imageId)
        ? currentTag.imageId
        : newest.imageId
      modals.openHistoryViewer(history, initialImageId, {
        dismissLabel: 'Close',
        replaceImageId: null,
      })
    } else if (selectedKey === 'view_prompt') {
      await refreshActiveChatId()
      modals.viewLastPrompt()
    } else if (selectedKey === 'delete') void deleteImage()
    else if (selectedKey === 'delete_all') void deleteAllImages()
  }

  const widget = mountShutterFloatWidget({
    ctx,
    settings,
    width: target.width,
    height: target.height,
    chromeless: target.chromeless,
    onGenerate: () => { void triggerGenerate(undefined, undefined, false, settings.defaultAction === 'replace') },
    onMenu: (x, y) => { void showWidgetMenu(x, y) },
  })
  // A selected native pop-out must render immediately. Chat state is loaded
  // independently because the child WebView's application store starts empty.
  widget.setVisible(true)
  void refreshActiveChatId()

  const modals = createModals({
    ctx,
    comms,
    getSettings: () => settings,
    triggerGenerate,
    handleGenerationResult,
    setGeneratingState,
    callImageGen,
    callPreviewPrompt,
    notifyGenerationSkipped,
    parseErrorMessage,
    getActiveChatId: () => activeChatId ?? undefined,
  })

  const unsubChatSwitched = ctx.events.on('CHAT_SWITCHED', (event: any) => {
    activeChatId = typeof event?.chatId === 'string' ? event.chatId : null
  })

  const unsubBackend = ctx.onBackendMessage((payload: any) => {
    if (comms.handleBackendMessage(payload)) return
    if (payload?.type !== 'settings' || !payload.settings) return
    settings = payload.settings as Settings
    widget.syncAppearance(settings)
  })
  ctx.sendToBackend({ type: 'request_settings' })

  return () => {
    unsubBackend()
    unsubChatSwitched()
    modals.dispose()
    comms.dispose()
    widget.destroy()
    removeStyle()
    ctx.dom.cleanup()
  }
}
