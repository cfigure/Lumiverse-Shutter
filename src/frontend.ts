import type { SpindleFrontendContext, SpindleFloatWidgetHandle } from 'lumiverse-spindle-types'
import { getIconSet } from './icons'
import { clampShutterImageWidth, type Settings } from './settings'
import { SHUTTER_CSS } from './styles'
import { createComms } from './comms'
import { createLightboxPromptLabel } from './lightbox'
import { createModals } from './modals'
import { createSettingsPanel } from './settings-panel'
import type { GenerationHistoryRecord, GenerationOrigin, GenerationTarget } from './history'

// ── Types ──

export type GenerationResult = {
  imageId: string
  imageUrl: string
  handledByNative: boolean
  prompt: string
  negativePrompt: string
  promptMode: string
}

// Native ImageGen returns { generated: false, reason } when the scene hasn't
// changed enough (scene prompt mode only, and only when the native
// forceGeneration setting — "Ignore Scene Change Detection" in the panel —
// is off). That's expected behaviour, not a failure, so it's modelled as a
// distinct outcome rather than a thrown error.
export type GenerationSkipped = {
  skipped: true
  reason: string
}

// ── Constants ──

const WIDGET_SIZES: Record<string, number> = { small: 44, medium: 56, large: 72, xlarge: 96 }
const DRAG_THRESHOLD_PX = 5
const DRAG_THRESHOLD_MS = 300
const LONG_PRESS_MS = 500

// ── Helpers ──

function parseErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    const msg = parsed.message || parsed.error?.message || (typeof parsed.error === 'string' ? parsed.error : null)
    if (msg) return msg
  } catch { /* not full JSON — try substring */ }

  try {
    const i = raw.indexOf('{')
    if (i >= 0) {
      const parsed = JSON.parse(raw.slice(i))
      const msg = parsed.message || parsed.error?.message || (typeof parsed.error === 'string' ? parsed.error : null)
      if (msg) return msg
    }
  } catch { /* not JSON at all */ }

  return raw
}

// ── Setup ──

export function setup(ctx: SpindleFrontendContext) {

  let settings: Settings | null = null
  let generating = false
  const comms = createComms(ctx)
  let floatWidget: SpindleFloatWidgetHandle | null = null
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
    else if (next.showFloatWidget && prev && next.widgetSize !== prev.widgetSize) resizeFloatWidget()

    if (next.showFloatWidget && prev && next.widgetStyle !== prev.widgetStyle) updateFloatIcon()
    if (!prev || next.iconTheme !== prev.iconTheme) {
      if (next.showFloatWidget) updateFloatIcon()
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
      message: `Shutter needs: ${missing.join(', ')}. Interceptor access removes Shutter Markdown image tags from model prompts. App Manipulation access shows the generation prompt below Shutter images in the native lightbox.`,
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

  let cachedNativeSettings: Record<string, any> | null = null

// Raw fetch is deliberate; see the note above callImageGen below.
  async function fetchNativeSettings(): Promise<Record<string, any>> {
    try {
      const resp = await fetch('/api/v1/settings/imageGeneration')
      if (!resp.ok) throw new Error(await resp.text())

      const data = await resp.json()
      const s = data?.value
      if (!s || typeof s !== 'object') throw new Error('Native ImageGen settings were not returned.')

      cachedNativeSettings = s
      return s
    } catch (err: any) {
      if (cachedNativeSettings !== null) return cachedNativeSettings
      const details = err?.message ? ` ${parseErrorMessage(err.message)}` : ''
      throw new Error(`Native ImageGen settings could not be loaded. Make sure Lumiverse ImageGen is available and configured.${details}`)
    }
  }

  // Deliberate raw fetch, and it must stay frontend-side: these are the
  // native scene-pipeline routes, which have no Spindle API equivalent
  // (spindle.imageGen is the connection-profile API, a different pipeline),
  // and they authenticate via the user's browser session, which the backend
  // subprocess does not have.
  async function callImageGen(
    chatId: string,
    overrides?: Record<string, any>,
    target?: GenerationTarget,
  ): Promise<GenerationResult | GenerationSkipped> {
    const native = await fetchNativeSettings()
    const body: Record<string, any> = {
      ...native,
      ...overrides,
      chatId,
    }

    // Pin native attach-to-message mode to the same response that owns the
    // Shutter history. This prevents a new trailing message from retargeting
    // an in-flight generation.
    if (body.outputTarget === 'attach_to_message' && target) {
      body.attachToMessageId = target.messageId
    }

    const resp = await fetch('/api/v1/image-gen/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) throw new Error(await resp.text())
    const result = await resp.json()
    if (!result.generated) {
      return { skipped: true, reason: result.reason || 'Scene has not changed enough' }
    }
    if (!result.imageId) throw new Error('Image generated but not persisted')
    return {
      imageId: result.imageId,
      imageUrl: result.imageUrl || `/api/v1/image-gen/results/${result.imageId}`,
      handledByNative: !!result.message,
      prompt: typeof result.prompt === 'string' ? result.prompt : (typeof overrides?.prompt === 'string' ? overrides.prompt : ''),
      negativePrompt: typeof result.negativePrompt === 'string' ? result.negativePrompt : (typeof overrides?.negativePrompt === 'string' ? overrides.negativePrompt : ''),
      promptMode: overrides?.skipParse ? 'custom' : (typeof body.promptMode === 'string' ? body.promptMode : 'scene'),
    }
  }

  async function callPreviewPrompt(chatId: string): Promise<{ prompt: string; negativePrompt: string }> {
    const native = await fetchNativeSettings()
    const resp = await fetch('/api/v1/image-gen/preview-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId,
        promptMode: native.promptMode,
        prompt: native.customPrompt,
        negativePrompt: native.customNegativePrompt,
        promptPresetId: native.activePromptPresetId,
        promptGenerationTimeoutSeconds: native.promptGenerationTimeoutSeconds,
      }),
    })
    if (!resp.ok) throw new Error(await resp.text())
    const result = await resp.json()
    return {
      prompt: result.prompt || '',
      negativePrompt: result.negativePrompt || '',
    }
  }

  // ── Lightbox prompt label (1.0.6) ── moved whole to lightbox.ts

  // The lightbox is constructed before the modal factory below. Keep a tiny
  // indirection so its expanded View History action can open the shared
  // history viewer without changing the compact mobile pill or construction
  // order.
  let openHistoryFromLightbox: (records: GenerationHistoryRecord[], imageId: string) => void = () => {}
  const lightboxPromptLabel = createLightboxPromptLabel({
    ctx,
    comms,
    getSettings: () => settings,
    hasPermission: (p) => grantedPermissions.has(p),
    openHistory: (records, imageId) => openHistoryFromLightbox(records, imageId),
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

    let history: GenerationHistoryRecord[] = []
    if (settings?.generationHistory) {
      history = await comms.appendGenerationHistory(target, {
        imageId: result.imageId,
        prompt: result.prompt,
        negativePrompt: result.negativePrompt,
        promptMode: result.promptMode,
        origin,
      })
    }

    // Native output modes own their own UI/insertion, but their successful
    // generations are still useful to Prompt View and cross-device history.
    if (result.handledByNative) return

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
    if (!floatWidget) return
    const btn = floatWidget.root.querySelector('.sh-float-btn') as HTMLButtonElement | null
    if (btn) {
      btn.disabled = generating
      btn.classList.toggle('sh-generating', generating)
    }
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
        { key: 'view_prompt', label: 'View Prompt' },
        { key: 'div1', label: '', type: 'divider' },
        { key: 'delete', label: 'Remove', danger: true },
        { key: 'delete_all', label: 'Remove All', danger: true },
      ],
    })

    if (selectedKey === 'append') triggerGenerate()
    else if (selectedKey === 'replace') triggerGenerate(undefined, undefined, false, true)
    else if (selectedKey === 'force') triggerGenerate(undefined, undefined, false, settings?.defaultAction === 'replace', true)
    else if (selectedKey === 'view_prompt') modals.viewLastPrompt()
    else if (selectedKey === 'delete') deleteImage()
    else if (selectedKey === 'delete_all') deleteAllImages()
  }

  // ── Float widget ──

   function setupFloatWidget() {
    if (floatWidget) return
    if (!settings) return
    const size = WIDGET_SIZES[settings.widgetSize] || 44
    floatWidget = ctx.ui.createFloatWidget({
      width: size, height: size,
      initialPosition: { x: 60, y: window.innerHeight - 140 },
      snapToEdge: true, tooltip: 'Shutter', chromeless: true,
    })

    const btn = document.createElement('button')
    btn.className = 'sh-float-btn'
    const icon = getIconSet(settings.iconTheme)
    btn.innerHTML = settings.widgetStyle === 'mono' ? icon.floatingMono : icon.floatingColor

    let pointerStart: { x: number; y: number; time: number } | null = null
    let longPressTimer: ReturnType<typeof setTimeout> | null = null
    let longPressFired = false

    btn.addEventListener('pointerdown', (e) => {
      // Primary button / touch only. Right-click is handled exclusively by
      // the contextmenu listener, so it must not arm the tap or long-press
      // tracker (misc: right-click was triggering a generation AND the menu).
      if (e.button !== 0) return
      pointerStart = { x: e.clientX, y: e.clientY, time: Date.now() }
      longPressFired = false
      longPressTimer = setTimeout(() => {
        longPressFired = true
        longPressTimer = null
        navigator.vibrate?.(50)
        showWidgetMenu(e.clientX, e.clientY)
      }, LONG_PRESS_MS)
    })

    btn.addEventListener('pointermove', (e) => {
      if (!pointerStart || !longPressTimer) return
      const dx = Math.abs(e.clientX - pointerStart.x)
      const dy = Math.abs(e.clientY - pointerStart.y)
      if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
    })

    btn.addEventListener('pointerup', (e) => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
      if (e.button !== 0) { pointerStart = null; return }
      if (!pointerStart || longPressFired) { pointerStart = null; return }
      const dx = Math.abs(e.clientX - pointerStart.x)
      const dy = Math.abs(e.clientY - pointerStart.y)
      const dt = Date.now() - pointerStart.time
      pointerStart = null

      if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX && dt < DRAG_THRESHOLD_MS) {
        triggerGenerate(undefined, undefined, false, settings?.defaultAction === 'replace')
      }
    })

    btn.addEventListener('pointercancel', () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
      pointerStart = null
    })

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showWidgetMenu(e.clientX, e.clientY)
    })

    floatWidget.root.appendChild(btn)

    const active = ctx.getActiveChat()
    floatWidget.setVisible(!!active.chatId)
  }

  function destroyFloatWidget() {
    if (!floatWidget) return
    floatWidget.destroy()
    floatWidget = null
  }

  function resizeFloatWidget() {
    if (!floatWidget) return
    if (!settings) return
    const size = WIDGET_SIZES[settings.widgetSize] || 44
    floatWidget.setSize(size, size)
  }

  function updateFloatIcon() {
    if (!floatWidget) return
    if (!settings) return
    const svg = floatWidget.root.querySelector('svg')
    if (svg) {
      const btn = svg.parentElement
      if (btn) {
        const icon = getIconSet(settings.iconTheme)
        btn.innerHTML = settings.widgetStyle === 'mono' ? icon.floatingMono : icon.floatingColor
      }
    }
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
  openHistoryFromLightbox = (records, imageId) => modals.openHistoryViewer(records, imageId)

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
