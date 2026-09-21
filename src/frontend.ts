import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { getIconSet } from './icons'
import { clampShutterImageWidth, type Settings } from './settings'
import { SHUTTER_CSS } from './styles'
import { createComms } from './comms'
import { createLightboxPromptLabel } from './lightbox'
import { createModals } from './modals'
import { createSettingsPanel } from './settings-panel'
import type { GenerationHistoryRecord, GenerationOrigin, GenerationTarget } from './history'
import { mountShutterFloatWidget, type ShutterFloatWidget } from './float-widget'
import {
  createNativeImageGen,
  parseErrorMessage,
  type GenerationResult,
} from './native-image-gen'

// ── Types ──

// ── Constants ──

const PERMISSION_LABELS: Record<string, string> = {
  chat_mutation: 'Chat Mutation',
  ui_panels: 'UI Panels',
  interceptor: 'Interceptor',
  app_manipulation: 'App Manipulation',
}

// ── Setup ──

export function setup(ctx: SpindleFrontendContext) {

  let settings: Settings | null = null
  let generating = false
  const comms = createComms(ctx)
  let floatWidget: ShutterFloatWidget | null = null
  let inputAction: any = null
  let removeShutterImageLayoutStyle: (() => void) | null = null

  function syncShutterImageLayoutStyle(): void {
    removeShutterImageLayoutStyle?.()
    removeShutterImageLayoutStyle = null

    if (!settings || settings.shutterImageLayout === 'off') return

    const width = clampShutterImageWidth(settings.shutterImageWidth)
    const align = settings.shutterImageAlign === 'left' || settings.shutterImageAlign === 'right'
      ? settings.shutterImageAlign
      : 'center'

    const textAlign = align
    const marginLeft = align === 'right' || align === 'center' ? 'auto' : '0'
    const marginRight = align === 'left' || align === 'center' ? 'auto' : '0'

    removeShutterImageLayoutStyle = ctx.dom.addStyle(`
      [data-component="MessageContent"] p:has(img[alt="shutter"]) {
        --shutter-image-width: ${width}%;
        --prose-image-max-width: var(--shutter-image-width);
        --prose-image-max-height: none;
        text-align: ${textAlign} !important;
        overflow: visible !important;
      }
      [data-component="MessageContent"] p:has(img[alt="shutter"]) > span:has(> img[alt="shutter"]),
      [data-component="MessageContent"] p:has(img[alt="shutter"]) > a:has(img[alt="shutter"]) {
        display: block !important;
        width: var(--shutter-image-width) !important;
        max-width: 100% !important;
        max-height: none !important;
        overflow: visible !important;
        margin-left: ${marginLeft} !important;
        margin-right: ${marginRight} !important;
      }
      [data-component="MessageContent"] p:has(img[alt="shutter"]) img[alt="shutter"] {
        display: block !important;
        width: 100% !important;
        height: auto !important;
        max-height: none !important;
        object-fit: contain !important;
        border-radius: 10px !important;
      }
    `)
  }

  // ── Auto-generate state ──

  let autoGenCounter = 0
  let autoGenTarget = 1

  function rollAutoGenTarget() {
    if (!settings) return
    switch (settings.autoGenerate) {
      case 'every':
        autoGenTarget = 1
        break
      case 'interval':
        autoGenTarget = Math.max(1, settings.autoGenerateInterval)
        break
      case 'random': {
        const min = Math.max(1, settings.autoGenerateRandomMin)
        const max = Math.max(min, settings.autoGenerateRandomMax)
        autoGenTarget = min + Math.floor(Math.random() * (max - min + 1))
        break
      }
      default:
        autoGenTarget = Infinity
    }
  }

  function resetAutoGenCounter() {
    autoGenCounter = 0
    rollAutoGenTarget()
  }

  // ── Settings change logic (single source of truth) ──

  function applySettingsChange(prev: Settings | null, next: Settings) {
    settings = next
    lightboxPromptLabel.sync()
    syncShutterImageLayoutStyle()

    if (next.showFloatWidget && !prev?.showFloatWidget) setupFloatWidget()
    else if (!next.showFloatWidget && prev?.showFloatWidget) destroyFloatWidget()
    else if (next.showFloatWidget && prev) floatWidget?.syncAppearance(next)

    if (!prev || next.iconTheme !== prev.iconTheme) {
      updateInputActionIcon()
    }
    if (
      !prev ||
      next.autoGenerate !== prev.autoGenerate ||
      next.autoGenerateInterval !== prev.autoGenerateInterval ||
      next.autoGenerateRandomMin !== prev.autoGenerateRandomMin ||
      next.autoGenerateRandomMax !== prev.autoGenerateRandomMax
    ) {
      resetAutoGenCounter()
    }
  }

  // ── Optimistic settings update ──

  function updateSettings(patch: Partial<Settings>) {
    if (!settings) return
    const prev = { ...settings }
    const next = { ...settings, ...patch }
    applySettingsChange(prev, next)
    ctx.sendToBackend({ type: 'update_settings', settings: patch })
  }

  // ── Permissions ──

  let grantedPermissions = new Set<string>()

  function applyGrantedPermissions(granted: string[]): void {
    const hadInterceptor = grantedPermissions.has('interceptor')
    const hadAppManipulation = grantedPermissions.has('app_manipulation')
    grantedPermissions = new Set(granted)
    const hasInterceptor = grantedPermissions.has('interceptor')
    const hasAppManipulation = grantedPermissions.has('app_manipulation')

    // Refresh the permission-sensitive rows if their effective state changed.
    if ((hadInterceptor !== hasInterceptor || hadAppManipulation !== hasAppManipulation) && settings && settingsPanel.isMounted()) {
      settingsPanel.destroy()
      settingsPanel.mount(settings)
    }
    lightboxPromptLabel.sync()
  }

  ctx.permissions.getGranted().then((granted: string[]) => {
    applyGrantedPermissions(granted)
    const needed = ['chat_mutation', 'ui_panels', 'interceptor', 'app_manipulation']
    const missing = needed.filter(p => !granted.includes(p))
    if (missing.length === 0) return
    ctx.ui.showConfirm({
      title: 'Permissions Required',
      message: `Shutter needs: ${missing.map(p => PERMISSION_LABELS[p] ?? p).join(', ')}. Interceptor access removes Shutter Markdown image tags from model prompts. App Manipulation access shows prompt and history controls below Shutter images in the native lightbox.`,
      variant: 'info',
      confirmLabel: 'Grant',
      cancelLabel: 'Not Now',
    }).then(async ({ confirmed }: { confirmed: boolean }) => {
      if (!confirmed) return
      try {
        const updated = await ctx.permissions.request(missing, {
          reason: 'Shutter uses chat and panel access for image insertion, interceptor access to remove Shutter Markdown image tags from model prompts, and app manipulation access to show generation prompts in the native image lightbox.',
        })
        applyGrantedPermissions(updated)
      } catch {
        ctx.ui.showConfirm({
          title: 'Permissions Not Granted',
          message: 'Shutter can still run with limited functionality. Without Interceptor permission, Shutter image tags cannot be removed from model prompts. Without App Manipulation permission, prompts cannot be shown in the image lightbox.',
          variant: 'info',
          confirmLabel: 'OK',
          cancelLabel: 'Dismiss',
        })
      }
    }).catch(() => { /* user dismissed the prompt */ })
  })

  // ── Styles ── (static rules live in styles.ts)

  const removeStyle = ctx.dom.addStyle(SHUTTER_CSS)

  // ── Settings panel ── moved whole to settings-panel.ts

  const settingsPanel = createSettingsPanel({
    ctx,
    updateSettings,
    hasPermission: (p) => grantedPermissions.has(p),
    clearGenerationHistory: () => comms.clearGenerationHistory(),
  })

  // ── Native ImageGen ──

  const { fetchNativeSettings, callImageGen, callPreviewPrompt } = createNativeImageGen()

  // ── Lightbox prompt label (1.0.6) ── moved whole to lightbox.ts

  // The lightbox is constructed before the modal factory below. Keep a tiny
  // indirection so its expanded View History action can open the shared
  // history viewer without changing the compact mobile pill or construction
  // order.
  let openHistoryFromLightbox: (records: GenerationHistoryRecord[], imageId: string, closeUnderlyingLightbox?: () => void) => void = () => {}
  const lightboxPromptLabel = createLightboxPromptLabel({
    ctx,
    comms,
    getSettings: () => settings,
    hasPermission: (p) => grantedPermissions.has(p),
    openHistory: (records, imageId, closeUnderlyingLightbox) => openHistoryFromLightbox(records, imageId, closeUnderlyingLightbox),
  })

  // ── Post-generation handling ──

  // Native parity note: when a generation is skipped (scene unchanged), the
  // native ImageGenPanel shows the reason as a passive inline banner in the
  // panel. Shutter has no panel surface at trigger time, so the nearest
  // equivalent weight is a toast — passive and non-interrupting, unlike the
  // error modal, which is reserved for genuine failures. Toasts are
  // backend-only in Spindle, hence the message round-trip.
  function notifyGenerationSkipped(reason: string) {
    ctx.sendToBackend({ type: 'show_toast', level: 'info', message: `${reason} — generation skipped.` })
  }

  function setGeneratingState(active: boolean) {
    generating = active
    updateFloatBtnState()
  }

  async function handleGenerationResult(
    result: GenerationResult,
    target: GenerationTarget,
    isAuto: boolean,
    replace = false,
    origin: GenerationOrigin = isAuto ? 'auto' : 'manual',
  ): Promise<void> {
    setGeneratingState(false)
    resetAutoGenCounter()

    // Native output modes own their own UI/insertion. Generation History is a
    // Shutter-specific feature, so only Shutter-managed results are recorded.
    if (result.handledByNative) return

    let history: GenerationHistoryRecord[] = []
    if (settings?.generationHistory) {
      history = await comms.appendGenerationHistory(target, {
        imageId: result.imageId,
        prompt: result.prompt,
        negativePrompt: result.negativePrompt,
        promptMode: result.promptMode,
        origin,
        provider: result.provider,
        model: result.model,
      })
    }

    const afterAction = isAuto ? settings?.autoGenerateAfter : settings?.afterGenerate
    if (afterAction === 'auto_insert') {
      ctx.sendToBackend({
        type: 'insert_into_message',
        imageId: result.imageId,
        messageId: target.messageId,
        chatId: target.chatId,
        target,
        replace,
      })
    } else {
      modals.openDestinationModal(result, target, isAuto, replace, history)
    }
  }

  // ── Generate ──

  async function triggerGenerate(
    messageId?: string,
    chatId?: string,
    isAuto = false,
    replace = false,
    force = false,
    pinnedTarget?: GenerationTarget,
    origin: GenerationOrigin = isAuto ? 'auto' : 'manual',
  ) {
    if (generating || modals.isPromptPreviewOpen()) return

    if (!chatId) {
      const active = ctx.getActiveChat()
      chatId = active.chatId ?? undefined
      if (!chatId) return
    }

    setGeneratingState(true)

    try {
      const target = pinnedTarget ?? await comms.resolveGenerationTarget(chatId, messageId || '__last__')
      if (!target) throw new Error('No message response is available for this generation.')

      const native = await fetchNativeSettings()
      const outputTarget = native.outputTarget || 'background'

      if (isAuto && (outputTarget === 'chat_attachment' || outputTarget === 'attach_to_message')) {
        setGeneratingState(false)
        return
      }

      const showPreview = native.previewPromptBeforeGenerate
        && (!isAuto || settings?.autoPreviewPrompt)
      if (showPreview) {
        try {
          const preview = await callPreviewPrompt(chatId)
          setGeneratingState(false)
          modals.openPromptPreviewModal(preview.prompt, preview.negativePrompt, target, isAuto, replace, origin)
        } catch (err: any) {
          setGeneratingState(false)
          if (!isAuto) modals.showErrorModal(parseErrorMessage(err.message))
        }
        return
      }

      const result = await callImageGen(chatId, force ? { forceGeneration: true } : undefined, target)
      if ('skipped' in result) {
        setGeneratingState(false)
        if (!isAuto) notifyGenerationSkipped(result.reason)
        return
      }
      await handleGenerationResult(result, target, isAuto, replace, origin)
    } catch (err: any) {
      setGeneratingState(false)
      if (!isAuto) modals.showErrorModal(parseErrorMessage(err.message))
    }
  }

  function updateFloatBtnState() {
    floatWidget?.setGenerating(generating)
  }

  // ── Chat visibility: CHAT_SWITCHED event ──

  const unsubChatSwitched = ctx.events.on('CHAT_SWITCHED', (event: any) => {
    if (!floatWidget) return
    floatWidget.setVisible(event.chatId !== null)
  })

  // ── Delete image ──

  async function deleteImage() {
    const active = ctx.getActiveChat()
    const chatId = active.chatId ?? undefined
    if (!chatId) return

    if (settings?.deleteConfirmation === 'always') {
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

  async function deleteAllImages() {
    const active = ctx.getActiveChat()
    const chatId = active.chatId ?? undefined
    if (!chatId) return

    if (settings?.deleteConfirmation !== 'never') {
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

  // ── Widget context menu ──

  async function showWidgetMenu(x: number, y: number) {
    // Consistency with the widget lock: while a generation is in flight the
    // widget is disabled and spinning, so the advanced menu (both long-press
    // and right-click paths route through here) is locked too.
    if (generating) return

    // "Force Generate" is shown only when the native scene gate is live —
    // scene prompt mode with the native forceGeneration setting off (its UI
    // label in the ImageGen panel is "Ignore Scene Change Detection"; the
    // panel's per-press "Force Generate" *button* is the thing this menu item
    // mirrors). That is the only configuration in which the flag is ever
    // consulted server-side: custom and parsed_custom modes never produce a
    // scene (the gate is bypassed entirely), and with the toggle on every
    // press is already forced. In every hidden case the item would be
    // indistinguishable from Append. If native settings can't be read,
    // default to showing it — a redundant menu row is harmless, a missing
    // one isn't recoverable from inside the menu.
    let showForce = true
    try {
      const native = await fetchNativeSettings()
      const promptMode = native.promptMode || 'scene' // server defaults absent promptMode to 'scene'
      showForce = promptMode === 'scene' && !native.forceGeneration
    } catch { /* keep showForce = true */ }

    const { selectedKey } = await ctx.ui.showContextMenu({
      position: { x, y },
      items: [
        { key: '_header', label: 'Last Message', disabled: true },
        { key: 'div0', label: '', type: 'divider' },
        { key: 'append', label: 'Append' },
        { key: 'replace', label: 'Replace' },
        ...(showForce ? [{ key: 'force', label: 'Force Generate' }] : []),
        { key: 'div_vp', label: '', type: 'divider' },
        ...(settings?.generationHistory ? [{ key: 'insert', label: 'Insert' }] : []),
        { key: 'view_prompt', label: 'View Prompt' },
        { key: 'div1', label: '', type: 'divider' },
        { key: 'delete', label: 'Remove', danger: true },
        { key: 'delete_all', label: 'Remove All', danger: true },
      ],
    })

    if (selectedKey === 'append') triggerGenerate()
    else if (selectedKey === 'replace') triggerGenerate(undefined, undefined, false, true)
    else if (selectedKey === 'force') triggerGenerate(undefined, undefined, false, settings?.defaultAction === 'replace', true)
    else if (selectedKey === 'insert') {
      const chatId = ctx.getActiveChat()?.chatId ?? undefined
      if (!chatId) return
      const [target, currentTag] = await Promise.all([
        comms.resolveGenerationTarget(chatId, '__last__'),
        comms.resolveShutterTag(chatId, '__last__', -1),
      ])
      const history = target ? await comms.getGenerationHistory(target) : []
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
          || (
            entry.createdAt === latest.createdAt
            && entry.imageId.localeCompare(latest.imageId) > 0
          )
          ? entry
          : latest,
      )
      const initialImageId =
        currentTag && history.some(entry => entry.imageId === currentTag.imageId)
          ? currentTag.imageId
          : newest.imageId
      
      modals.openHistoryViewer(history, initialImageId, {
        dismissLabel: 'Close',
        replaceImageId: null,
      })      
    }
    else if (selectedKey === 'view_prompt') modals.viewLastPrompt()
    else if (selectedKey === 'delete') deleteImage()
    else if (selectedKey === 'delete_all') deleteAllImages()
  }

  // ── Float widget ──

  function setupFloatWidget() {
    if (floatWidget) return
    if (!settings) return
    floatWidget = mountShutterFloatWidget({
      ctx,
      settings,
      onGenerate: () => triggerGenerate(undefined, undefined, false, settings?.defaultAction === 'replace'),
      onMenu: showWidgetMenu,
    })
    const active = ctx.getActiveChat()
    floatWidget.setVisible(!!active.chatId)
  }

  function destroyFloatWidget() {
    if (!floatWidget) return
    floatWidget.destroy()
    floatWidget = null
  }

  // ── Input bar action ──

  function updateInputActionIcon() {
    const icon = getIconSet(settings?.iconTheme ?? 'aperture')
    inputAction?.destroy()
    inputAction = ctx.ui.registerInputBarAction({
      id: 'shutter-generate',
      label: 'Generate Image',
      iconSvg: icon.inputBar,
    })
    inputAction.onClick(() => triggerGenerate(undefined, undefined, false, settings?.defaultAction === 'replace'))
  }

  updateInputActionIcon()

  // ── Auto-generate: listen for AI messages ──
  // Frontend event listening rides the user's own WebSocket and is ungated.
  // Backend subscriptions to generation lifecycle events require the
  // 'generation' permission. If this listener ever moves server-side,
  // 'generation' goes back into spindle.json.  

  const unsubCharMsg = ctx.events.on('GENERATION_ENDED', (event: any) => {
    if (!settings || settings.autoGenerate === 'off') return
    if (event.error || event.impersonateDraft) return
    autoGenCounter++
    if (autoGenCounter >= autoGenTarget) {
      // Auto-insert is anchored to the AI message that triggered it. The
      // image illustrates that response's scene. If the event ever arrives
      // without a messageId, downstream falls back to '__last__' (the
      // literal newest message at insert time).
      triggerGenerate(event.messageId, event.chatId, true)
    }
  })

  // ── Modals ── moved whole to modals.ts

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
  })
  openHistoryFromLightbox = (records, imageId, closeUnderlyingLightbox) => modals.openHistoryViewer(records, imageId, {
    closeUnderlyingLightbox,
  })

  // ── Backend messages ──

  const unsubBackend = ctx.onBackendMessage((payload: any) => {
    // Round-trip replies are consumed by comms.
    if (comms.handleBackendMessage(payload)) return

    if (payload.type === 'generation_history_cleared') {
      lightboxPromptLabel.onHistoryCleared()
      modals.onHistoryCleared()
      return
    }

    if (payload.type !== 'settings') return

    const incoming: Settings = payload.settings
    const isFirstLoad = settings === null
    const changed = isFirstLoad || Object.keys(incoming).some(
      key => (settings as any)[key] !== (incoming as any)[key]
    )

    if (changed) {
      const prev = settings ? { ...settings } : null
      applySettingsChange(prev, incoming)

      settingsPanel.applyIncoming(incoming)
    }
  })

  // ── Init ──

  ctx.sendToBackend({ type: 'request_settings' })

  // ── Cleanup ──

  return () => {
    lightboxPromptLabel.dispose()
    comms.dispose()
    unsubBackend()
    unsubCharMsg()
    unsubChatSwitched()
    inputAction?.destroy()
    destroyFloatWidget()
    settingsPanel.destroy()
    modals.dispose()
    removeShutterImageLayoutStyle?.()
    removeShutterImageLayoutStyle = null
    removeStyle()

    ctx.dom.cleanup()
  }
}
