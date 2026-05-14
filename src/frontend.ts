import type { SpindleFrontendContext, SpindleFloatWidgetHandle } from 'lumiverse-spindle-types'
import { ICON_INPUT_BAR, ICON_FLOAT_MONO, ICON_FLOAT_COLOR } from './icons'

// ── Types ──

type Settings = {
  showFloatWidget: boolean
  toastOnInsert: boolean
  afterGenerate: 'ask_to_insert' | 'auto_insert'
  widgetSize: 'small' | 'medium' | 'large'
  widgetStyle: 'color' | 'mono'
  autoGenerate: 'off' | 'every' | 'interval' | 'random'
  autoGenerateInterval: number
  autoGenerateRandomMin: number
  autoGenerateRandomMax: number
  autoGenerateAfter: 'auto_insert' | 'ask_to_insert'
}

// ── Constants ──

const DEFAULT_SETTINGS: Settings = {
  showFloatWidget: false,
  toastOnInsert: true,
  afterGenerate: 'ask_to_insert',
  widgetSize: 'small',
  widgetStyle: 'color',
  autoGenerate: 'off',
  autoGenerateInterval: 3,
  autoGenerateRandomMin: 3,
  autoGenerateRandomMax: 7,
  autoGenerateAfter: 'auto_insert',
}

const WIDGET_SIZES: Record<string, number> = { small: 44, medium: 56, large: 72 }
const DRAG_THRESHOLD_PX = 5
const DRAG_THRESHOLD_MS = 300
const OUTPUT_TARGET_CACHE_MS = 5_000

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

function isInChatView(): boolean {
  return /^\/chat\/[^/]+/.test(window.location.pathname)
}

// ── Setup ──

export function setup(ctx: SpindleFrontendContext) {

  let settings: Settings = { ...DEFAULT_SETTINGS }
  let generating = false
  let floatWidget: SpindleFloatWidgetHandle | null = null

  // ── Auto-generate state ──

  let autoGenCounter = 0
  let autoGenTarget = 1

  function rollAutoGenTarget() {
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

  function applySettingsChange(prev: Settings, next: Settings) {
    settings = next

    if (next.showFloatWidget && !prev.showFloatWidget) setupFloatWidget()
    else if (!next.showFloatWidget && prev.showFloatWidget) destroyFloatWidget()
    else if (next.showFloatWidget && next.widgetSize !== prev.widgetSize) resizeFloatWidget()

    if (next.showFloatWidget && next.widgetStyle !== prev.widgetStyle) updateFloatIcon()
    if (
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
    const prev = { ...settings }
    const next = { ...settings, ...patch }
    applySettingsChange(prev, next)
    ctx.sendToBackend({ type: 'update_settings', settings: patch })
  }

  // ── Permissions ──

  ctx.permissions.getGranted().then((granted: string[]) => {
    const needed = ['chats', 'chat_mutation', 'ui_panels', 'generation']
    const missing = needed.filter(p => !granted.includes(p))
    if (missing.length === 0) return
    ctx.ui.showConfirm({
      title: 'Permissions Required',
      message: `Shutter needs: ${missing.join(', ')}.`,
      variant: 'info',
      confirmLabel: 'Grant',
      cancelLabel: 'Not Now',
    }).then(({ confirmed }) => { if (confirmed) ctx.permissions.request(missing) })
  })

  // ── Styles ──

  const removeStyle = ctx.dom.addStyle(`
    .sh-settings { padding: 8px 16px 16px; }
    .sh-heading { font-size: 15px; font-weight: 600; color: var(--lumiverse-text); margin-bottom: 4px; }
    .sh-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; }
    .sh-setting-label { font-size: 13px; color: var(--lumiverse-text); }
    .sh-setting-desc { font-size: 11.5px; color: var(--lumiverse-text-muted); margin-top: 2px; }
    .sh-select { padding: 5px 8px; border-radius: 6px; border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); font-size: 12px; font-family: inherit; cursor: pointer; min-width: 120px; flex-shrink: 0; }
    .sh-select:focus { outline: none; border-color: var(--lumiverse-accent); }
    .sh-input-num { padding: 5px 8px; border-radius: 6px; border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); font-size: 12px; font-family: inherit; width: 50px; text-align: center; }
    .sh-input-num:focus { outline: none; border-color: var(--lumiverse-accent); }
    .sh-range-row { display: flex; align-items: center; gap: 6px; }
    .sh-range-label { font-size: 12px; color: var(--lumiverse-text-muted); }
    .sh-divider { height: 1px; background: var(--lumiverse-border); margin: 10px 0; }
    .sh-float-btn { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; border: none; background: var(--lumiverse-accent); color: var(--lumiverse-accent-fg); border-radius: 50%; cursor: pointer; transition: opacity var(--lumiverse-transition-fast); }
    .sh-float-btn:hover { opacity: 0.85; }
    .sh-float-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sh-float-btn svg { transition: transform 0.2s ease; }
    .sh-float-btn.sh-generating svg { animation: sh-spin 1.2s linear infinite; }
    @keyframes sh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .sh-modal-body { display: flex; flex-direction: column; gap: 12px; }
    .sh-preview-img { width: 100%; max-height: 200px; object-fit: contain; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); margin-bottom: 4px; }
    .sh-dest-choices { display: flex; flex-direction: column; gap: 8px; }
    .sh-dest-btn { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill); color: var(--lumiverse-text); cursor: pointer; font-size: 13px; font-family: inherit; text-align: left; transition: background var(--lumiverse-transition-fast), border-color var(--lumiverse-transition-fast); }
    .sh-dest-btn:hover { border-color: var(--lumiverse-accent); background: var(--lumiverse-fill-subtle); }
    .sh-dest-label { font-weight: 500; }
    .sh-dest-desc { font-size: 11.5px; color: var(--lumiverse-text-muted); margin-top: 2px; }
  `)

  // ── Settings panel ──

  const settingsRoot = ctx.ui.mount('settings_extensions')

  function renderSettings() {
    settingsRoot.innerHTML = ''
    const container = document.createElement('div')
    container.className = 'sh-settings'

    const autoIsOff = settings.autoGenerate === 'off'
    const showInterval = settings.autoGenerate === 'interval'
    const showRandom = settings.autoGenerate === 'random'

    container.innerHTML = `
      <div class="sh-heading">Shutter</div>

      <div class="sh-setting-row">
        <div>
          <div class="sh-setting-label">Floating Button</div>
          <div class="sh-setting-desc">Show a quick-access generate button on screen</div>
        </div>
        <input type="checkbox" id="sh-toggle-float" ${settings.showFloatWidget ? 'checked' : ''} />
      </div>

      <div class="sh-setting-row">
        <div>
          <div class="sh-setting-label">Widget Size</div>
          <div class="sh-setting-desc">Size of the floating button</div>
        </div>
        <select class="sh-select" id="sh-select-size">
          <option value="small" ${settings.widgetSize === 'small' ? 'selected' : ''}>Small (44px)</option>
          <option value="medium" ${settings.widgetSize === 'medium' ? 'selected' : ''}>Medium (56px)</option>
          <option value="large" ${settings.widgetSize === 'large' ? 'selected' : ''}>Large (72px)</option>
        </select>
      </div>

      <div class="sh-setting-row">
        <div>
          <div class="sh-setting-label">Widget Style</div>
          <div class="sh-setting-desc">Icon style for the floating button</div>
        </div>
        <select class="sh-select" id="sh-select-style">
          <option value="color" ${settings.widgetStyle === 'color' ? 'selected' : ''}>Colour</option>
          <option value="mono" ${settings.widgetStyle === 'mono' ? 'selected' : ''}>Monochrome</option>
        </select>
      </div>

      <div class="sh-setting-row">
        <div>
          <div class="sh-setting-label">Toast on Insert</div>
          <div class="sh-setting-desc">Show a notification when an image is inserted into a message</div>
        </div>
        <input type="checkbox" id="sh-toggle-toast" ${settings.toastOnInsert ? 'checked' : ''} />
      </div>

      <div class="sh-divider"></div>

      <div class="sh-setting-row">
        <div>
          <div class="sh-setting-label">After Generate</div>
          <div class="sh-setting-desc">What to do after a manual generation (when not in chat attachment mode)</div>
        </div>
        <select class="sh-select" id="sh-select-after">
          <option value="ask_to_insert" ${settings.afterGenerate === 'ask_to_insert' ? 'selected' : ''}>Ask to insert</option>
          <option value="auto_insert" ${settings.afterGenerate === 'auto_insert' ? 'selected' : ''}>Auto insert</option>
        </select>
      </div>

      <div class="sh-divider"></div>

      <div class="sh-heading">Auto Generate</div>

      <div class="sh-setting-row">
        <div>
          <div class="sh-setting-label">Mode</div>
          <div class="sh-setting-desc">Automatically generate after AI responses. Skipped when ImageGen is set to chat attachment.</div>
        </div>
        <select class="sh-select" id="sh-select-auto">
          <option value="off" ${settings.autoGenerate === 'off' ? 'selected' : ''}>Off</option>
          <option value="every" ${settings.autoGenerate === 'every' ? 'selected' : ''}>Every message</option>
          <option value="interval" ${settings.autoGenerate === 'interval' ? 'selected' : ''}>Every X messages</option>
          <option value="random" ${settings.autoGenerate === 'random' ? 'selected' : ''}>Random interval</option>
        </select>
      </div>

      <div class="sh-setting-row" id="sh-row-interval" style="display:${showInterval ? '' : 'none'}">
        <div>
          <div class="sh-setting-label">Interval</div>
          <div class="sh-setting-desc">Generate every X AI messages</div>
        </div>
        <input type="number" class="sh-input-num" id="sh-input-interval" min="1" max="99" value="${settings.autoGenerateInterval}" />
      </div>

      <div class="sh-setting-row" id="sh-row-random" style="display:${showRandom ? '' : 'none'}">
        <div>
          <div class="sh-setting-label">Random Range</div>
          <div class="sh-setting-desc">Generate randomly between X and Y AI messages</div>
        </div>
        <div class="sh-range-row">
          <input type="number" class="sh-input-num" id="sh-input-rand-min" min="1" max="99" value="${settings.autoGenerateRandomMin}" />
          <span class="sh-range-label">to</span>
          <input type="number" class="sh-input-num" id="sh-input-rand-max" min="1" max="99" value="${settings.autoGenerateRandomMax}" />
        </div>
      </div>

      <div class="sh-setting-row" id="sh-row-auto-after" style="display:${autoIsOff ? 'none' : ''}">
        <div>
          <div class="sh-setting-label">After Auto Generate</div>
          <div class="sh-setting-desc">What to do after an automatic generation</div>
        </div>
        <select class="sh-select" id="sh-select-auto-after">
          <option value="auto_insert" ${settings.autoGenerateAfter === 'auto_insert' ? 'selected' : ''}>Auto insert</option>
          <option value="ask_to_insert" ${settings.autoGenerateAfter === 'ask_to_insert' ? 'selected' : ''}>Ask to insert</option>
        </select>
      </div>
    `

    settingsRoot.appendChild(container)

    // ── Event listeners ──

    container.querySelector('#sh-toggle-float')?.addEventListener('change', (e) => {
      updateSettings({ showFloatWidget: (e.target as HTMLInputElement).checked })
    })
    container.querySelector('#sh-select-size')?.addEventListener('change', (e) => {
      updateSettings({ widgetSize: (e.target as HTMLSelectElement).value as Settings['widgetSize'] })
    })
    container.querySelector('#sh-select-style')?.addEventListener('change', (e) => {
      updateSettings({ widgetStyle: (e.target as HTMLSelectElement).value as Settings['widgetStyle'] })
    })
    container.querySelector('#sh-toggle-toast')?.addEventListener('change', (e) => {
      updateSettings({ toastOnInsert: (e.target as HTMLInputElement).checked })
    })
    container.querySelector('#sh-select-after')?.addEventListener('change', (e) => {
      updateSettings({ afterGenerate: (e.target as HTMLSelectElement).value as Settings['afterGenerate'] })
    })
    container.querySelector('#sh-select-auto')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as Settings['autoGenerate']
      updateSettings({ autoGenerate: mode })

      // Update conditional row visibility in-place. The optimistic update means
      // the backend echo won't trigger renderSettings (values already match), so
      // this is the only code path that shows/hides these rows immediately.
      const rowInterval = container.querySelector('#sh-row-interval') as HTMLElement | null
      const rowRandom = container.querySelector('#sh-row-random') as HTMLElement | null
      const rowAutoAfter = container.querySelector('#sh-row-auto-after') as HTMLElement | null
      if (rowInterval) rowInterval.style.display = mode === 'interval' ? '' : 'none'
      if (rowRandom) rowRandom.style.display = mode === 'random' ? '' : 'none'
      if (rowAutoAfter) rowAutoAfter.style.display = mode === 'off' ? 'none' : ''
    })
    container.querySelector('#sh-input-interval')?.addEventListener('change', (e) => {
      const val = Math.max(1, parseInt((e.target as HTMLInputElement).value) || 3)
      updateSettings({ autoGenerateInterval: val })
    })
    container.querySelector('#sh-input-rand-min')?.addEventListener('change', (e) => {
      const val = Math.max(1, parseInt((e.target as HTMLInputElement).value) || 3)
      updateSettings({ autoGenerateRandomMin: val })
    })
    container.querySelector('#sh-input-rand-max')?.addEventListener('change', (e) => {
      const val = Math.max(1, parseInt((e.target as HTMLInputElement).value) || 7)
      updateSettings({ autoGenerateRandomMax: val })
    })
    container.querySelector('#sh-select-auto-after')?.addEventListener('change', (e) => {
      updateSettings({ autoGenerateAfter: (e.target as HTMLSelectElement).value as Settings['autoGenerateAfter'] })
    })
  }

  // ── Native ImageGen ──

  let cachedOutputTarget: string | null = null
  let outputTargetFetchedAt = 0

  async function getImageGenOutputTarget(): Promise<string> {
    const now = Date.now()
    if (cachedOutputTarget !== null && (now - outputTargetFetchedAt) < OUTPUT_TARGET_CACHE_MS) {
      return cachedOutputTarget
    }
    try {
      const resp = await fetch('/api/v1/settings/imageGeneration')
      if (resp.ok) {
        const data = await resp.json()
        cachedOutputTarget = data?.value?.outputTarget || 'background'
        outputTargetFetchedAt = now
        return cachedOutputTarget
      }
    } catch { /* fall through */ }
    return cachedOutputTarget ?? 'background'
  }

  async function callImageGen(chatId: string) {
    const resp = await fetch('/api/v1/image-gen/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, forceGeneration: true }),
    })
    if (!resp.ok) throw new Error(await resp.text())
    const result = await resp.json()
    if (!result.generated) throw new Error(result.reason || 'Scene has not changed enough')
    if (!result.imageId) throw new Error('Image generated but not persisted')
    return {
      imageId: result.imageId,
      imageUrl: `/api/v1/images/${result.imageId}`,
      handledByNative: !!result.message,
    }
  }

  // ── Generate ──

  async function triggerGenerate(messageId?: string, chatId?: string, isAuto = false) {
    if (generating) return

    if (!chatId) {
      const active = ctx.getActiveChat()
      chatId = active.chatId ?? undefined
      if (!chatId) return
    }

    generating = true
    updateFloatBtnState()

    try {
      if (isAuto) {
        const outputTarget = await getImageGenOutputTarget()
        if (outputTarget === 'chat_attachment') {
          generating = false
          updateFloatBtnState()
          return
        }
      }

      const result = await callImageGen(chatId)
      generating = false
      updateFloatBtnState()
      resetAutoGenCounter()

      if (result.handledByNative) return

      const afterAction = isAuto ? settings.autoGenerateAfter : settings.afterGenerate

      if (afterAction === 'auto_insert') {
        ctx.sendToBackend({ type: 'insert_into_message', imageId: result.imageId, messageId: messageId || '__last__', chatId })
      } else {
        openDestinationModal(result.imageId, result.imageUrl, messageId || '__last__', chatId)
      }
    } catch (err: any) {
      generating = false
      updateFloatBtnState()
      if (!isAuto) {
        showErrorModal(parseErrorMessage(err.message))
      }
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

  // ── Chat visibility: event-driven route detection ──

  let lastFloatVisible: boolean | null = null

  function applyFloatVisibility() {
    if (!floatWidget) return
    const visible = isInChatView()
    if (visible !== lastFloatVisible) {
      lastFloatVisible = visible
      floatWidget.setVisible(visible)
    }
  }

  const originalPushState = window.history.pushState.bind(window.history)
  const originalReplaceState = window.history.replaceState.bind(window.history)

  window.history.pushState = function (...args: any[]) {
    const result = originalPushState(...args)
    applyFloatVisibility()
    return result
  }

  window.history.replaceState = function (...args: any[]) {
    const result = originalReplaceState(...args)
    applyFloatVisibility()
    return result
  }

  const onRouteChange = () => applyFloatVisibility()
  window.addEventListener('popstate', onRouteChange)
  window.addEventListener('hashchange', onRouteChange)

  // ── Float widget ──

  function setupFloatWidget() {
    if (floatWidget) return
    const size = WIDGET_SIZES[settings.widgetSize] || 44
    floatWidget = ctx.ui.createFloatWidget({
      width: size, height: size,
      initialPosition: { x: 60, y: window.innerHeight - 140 },
      snapToEdge: true, tooltip: 'Shutter', chromeless: true,
    })

    const btn = document.createElement('button')
    btn.className = 'sh-float-btn'
    btn.innerHTML = settings.widgetStyle === 'mono' ? ICON_FLOAT_MONO : ICON_FLOAT_COLOR

    let pointerStart: { x: number; y: number; time: number } | null = null

    btn.addEventListener('pointerdown', (e) => {
      pointerStart = { x: e.clientX, y: e.clientY, time: Date.now() }
    })

    btn.addEventListener('pointerup', (e) => {
      if (!pointerStart) return
      const dx = Math.abs(e.clientX - pointerStart.x)
      const dy = Math.abs(e.clientY - pointerStart.y)
      const dt = Date.now() - pointerStart.time
      pointerStart = null

      if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX && dt < DRAG_THRESHOLD_MS) {
        triggerGenerate()
      }
    })

    btn.addEventListener('pointercancel', () => {
      pointerStart = null
    })

    floatWidget.root.appendChild(btn)
    applyFloatVisibility()
  }

  function destroyFloatWidget() {
    if (!floatWidget) return
    lastFloatVisible = null
    floatWidget.destroy()
    floatWidget = null
  }

  function resizeFloatWidget() {
    if (!floatWidget) return
    const size = WIDGET_SIZES[settings.widgetSize] || 44
    floatWidget.setSize(size, size)
  }

  function updateFloatIcon() {
    if (!floatWidget) return
    const svg = floatWidget.root.querySelector('svg')
    if (svg) {
      const btn = svg.parentElement
      if (btn) btn.innerHTML = settings.widgetStyle === 'mono' ? ICON_FLOAT_MONO : ICON_FLOAT_COLOR
    }
  }

  // ── Input bar action ──

  const inputAction = ctx.ui.registerInputBarAction({
    id: 'shutter-generate',
    label: 'Shutter',
    iconSvg: ICON_INPUT_BAR,
  })
  inputAction.onClick(() => triggerGenerate())

  // ── Auto-generate: listen for AI messages ──

  const unsubCharMsg = ctx.events.on('GENERATION_ENDED', (event: any) => {
    if (settings.autoGenerate === 'off') return
    if (event.error || event.impersonateDraft) return
    autoGenCounter++
    if (autoGenCounter >= autoGenTarget) {
      triggerGenerate(event.messageId, event.chatId, true)
    }
  })

  // ── Modals ──

  function makeDestBtn(label: string, desc: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'sh-dest-btn'
    btn.innerHTML = `<div><div class="sh-dest-label">${label}</div><div class="sh-dest-desc">${desc}</div></div>`
    btn.addEventListener('click', onClick)
    return btn
  }

  function openDestinationModal(imageId: string, imageUrl: string, messageId: string, chatId: string) {
    const modal = ctx.ui.showModal({ title: 'Image Generated', width: 400, persistent: true })
    const container = document.createElement('div')
    container.className = 'sh-modal-body'

    const preview = document.createElement('img')
    preview.className = 'sh-preview-img'
    preview.src = imageUrl
    container.appendChild(preview)

    const choices = document.createElement('div')
    choices.className = 'sh-dest-choices'
    choices.appendChild(makeDestBtn('Insert into Message', 'Append this image inline in the chat message', () => {
      ctx.sendToBackend({ type: 'insert_into_message', imageId, messageId, chatId })
      modal.dismiss()
    }))
    choices.appendChild(makeDestBtn('Done', 'Image is already saved to the character gallery', () => {
      modal.dismiss()
    }))
    container.appendChild(choices)
    modal.root.appendChild(container)
  }

  function showErrorModal(message: string) {
    const modal = ctx.ui.showModal({ title: 'Generation Failed', width: 380 })
    const container = document.createElement('div')
    container.className = 'sh-modal-body'
    const msg = document.createElement('div')
    msg.style.cssText = 'font-size:13px;color:var(--lumiverse-text);line-height:1.5;text-align:center;padding:4px 0;'
    msg.textContent = message
    container.appendChild(msg)
    const btn = document.createElement('button')
    btn.className = 'sh-dest-btn'
    btn.style.cssText = 'justify-content:center;margin-top:4px;'
    btn.innerHTML = '<div class="sh-dest-label">OK</div>'
    btn.addEventListener('click', () => modal.dismiss())
    container.appendChild(btn)
    modal.root.appendChild(container)
  }

  // ── Backend messages ──

  const unsubBackend = ctx.onBackendMessage((payload: any) => {
    if (payload.type !== 'settings') return

    const incoming: Settings = payload.settings
    const changed = Object.keys(incoming).some(
      key => (settings as any)[key] !== (incoming as any)[key]
    )

    if (changed) {
      const prev = { ...settings }
      applySettingsChange(prev, incoming)
      renderSettings()
    }
  })

  // ── Init ──

  ctx.sendToBackend({ type: 'request_settings' })
  rollAutoGenTarget()

  // ── Cleanup ──

  return () => {
    unsubBackend()
    unsubCharMsg()
    inputAction.destroy()
    destroyFloatWidget()
    removeStyle()

    window.history.pushState = originalPushState
    window.history.replaceState = originalReplaceState
    window.removeEventListener('popstate', onRouteChange)
    window.removeEventListener('hashchange', onRouteChange)

    ctx.dom.cleanup()
  }
}
