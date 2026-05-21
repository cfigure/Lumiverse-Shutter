import type { SpindleFrontendContext, SpindleFloatWidgetHandle } from 'lumiverse-spindle-types'
import { ICON_INPUT_BAR, ICON_FLOAT_MONO, ICON_FLOAT_COLOR } from './icons'

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

type GenerationResult = {
  imageId: string
  imageUrl: string
  handledByNative: boolean
}

// ── Constants ──

const WIDGET_SIZES: Record<string, number> = { small: 44, medium: 56, large: 72 }
const DRAG_THRESHOLD_PX = 5
const DRAG_THRESHOLD_MS = 300
const NATIVE_SETTINGS_CACHE_MS = 5_000

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

  let settings: Settings | null = null
  let generating = false
  let floatWidget: SpindleFloatWidgetHandle | null = null

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

    if (next.showFloatWidget && !prev?.showFloatWidget) setupFloatWidget()
    else if (!next.showFloatWidget && prev?.showFloatWidget) destroyFloatWidget()
    else if (next.showFloatWidget && prev && next.widgetSize !== prev.widgetSize) resizeFloatWidget()

    if (next.showFloatWidget && prev && next.widgetStyle !== prev.widgetStyle) updateFloatIcon()
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
    /* Settings panel */
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
    .sh-loading { padding: 16px; font-size: 13px; color: var(--lumiverse-text-muted); }

    /* Float widget */
    .sh-float-btn { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; border: none; background: var(--lumiverse-accent); color: var(--lumiverse-accent-fg); border-radius: 50%; cursor: pointer; transition: opacity var(--lumiverse-transition-fast); }
    .sh-float-btn:hover { opacity: 0.85; }
    .sh-float-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sh-float-btn svg { transition: transform 0.2s ease; }
    .sh-float-btn.sh-generating svg { animation: sh-spin 1.2s linear infinite; }
    @keyframes sh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

    /* Modals (shared) */
    .sh-modal-body { display: flex; flex-direction: column; gap: 12px; }
    .sh-preview-img { width: 100%; max-height: 200px; object-fit: contain; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); margin-bottom: 4px; cursor: pointer; transition: opacity var(--lumiverse-transition-fast); }
    .sh-preview-img:hover { opacity: 0.85; }
    .sh-lightbox { position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; cursor: pointer; }
    .sh-lightbox img { max-width: 90vw; max-height: 90vh; object-fit: contain; border-radius: var(--lumiverse-radius); }
    .sh-dest-choices { display: flex; flex-direction: column; gap: 8px; }
    .sh-dest-btn { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill); color: var(--lumiverse-text); cursor: pointer; font-size: 13px; font-family: inherit; text-align: left; transition: background var(--lumiverse-transition-fast), border-color var(--lumiverse-transition-fast); }
    .sh-dest-btn:hover { border-color: var(--lumiverse-accent); background: var(--lumiverse-fill-subtle); }
    .sh-dest-label { font-weight: 500; }
    .sh-dest-desc { font-size: 11.5px; color: var(--lumiverse-text-muted); margin-top: 2px; }

    /* Prompt preview modal */
    .sh-prompt-subtitle { font-size: 12px; color: var(--lumiverse-text-muted); line-height: 1.4; margin-bottom: 4px; }
    .sh-prompt-field { display: flex; flex-direction: column; gap: 4px; }
    .sh-prompt-label { font-size: 11px; font-weight: 600; color: var(--lumiverse-text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .sh-prompt-textarea { width: 100%; min-height: 140px; padding: 10px; border-radius: 6px; border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); font-size: 13px; font-family: inherit; resize: vertical; box-sizing: border-box; line-height: 1.5; }
    .sh-prompt-textarea:focus { outline: none; border-color: var(--lumiverse-accent); }
    .sh-prompt-textarea-short { min-height: 80px; }
    .sh-prompt-error { font-size: 12px; color: var(--lumiverse-danger, #e55); }
    .sh-prompt-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
    .sh-prompt-btn { padding: 8px 14px; border-radius: 6px; border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); font-size: 13px; font-family: inherit; cursor: pointer; transition: background var(--lumiverse-transition-fast), border-color var(--lumiverse-transition-fast); }
    .sh-prompt-btn:hover { border-color: var(--lumiverse-accent); background: var(--lumiverse-fill-subtle); }
    .sh-prompt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sh-prompt-btn-primary { background: var(--lumiverse-accent); color: var(--lumiverse-accent-fg); border-color: var(--lumiverse-accent); }
    .sh-prompt-btn-primary:hover { opacity: 0.9; }
  `)

  // ── Settings panel ──

  const settingsRoot = ctx.ui.mount('settings_extensions')
  settingsRoot.innerHTML = '<div class="sh-loading">Loading…</div>'

  function renderSettings() {
    if (!settings) return
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
          <div class="sh-setting-label">Floating Widget</div>
          <div class="sh-setting-desc">Show a quick-access generate widget on screen</div>
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

      <div class="sh-setting-row">
        <div>
          <div class="sh-setting-label">Force Generation</div>
          <div class="sh-setting-desc">Always generate regardless of scene changes. When off, generation is skipped if the scene hasn't changed enough.</div>
        </div>
        <input type="checkbox" id="sh-toggle-force" ${settings.forceGeneration ? 'checked' : ''} />
      </div>

      <div class="sh-divider"></div>

      <div class="sh-setting-row">
        <div>
          <div class="sh-setting-label">After Generate</div>
          <div class="sh-setting-desc">What to do after a manual generation. Skipped when ImageGen is set to Insert into Chat or Attach to Last Message.</div>
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
          <div class="sh-setting-desc">Automatically generate after AI responses. Skipped when ImageGen is set to Insert into Chat or Attach to Last Message.</div>
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

      <div class="sh-setting-row" id="sh-row-auto-preview" style="display:${autoIsOff ? 'none' : ''}">
        <div>
          <div class="sh-setting-label">Preview Prompt on Auto</div>
          <div class="sh-setting-desc">Show the prompt preview before auto-generated images. Requires "Preview Prompt Before Generating" to be enabled in native ImageGen settings.</div>
        </div>
        <input type="checkbox" id="sh-toggle-auto-preview" ${settings.autoPreviewPrompt ? 'checked' : ''} />
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
    container.querySelector('#sh-toggle-force')?.addEventListener('change', (e) => {
      updateSettings({ forceGeneration: (e.target as HTMLInputElement).checked })
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
      const rowAutoPreview = container.querySelector('#sh-row-auto-preview') as HTMLElement | null
      if (rowInterval) rowInterval.style.display = mode === 'interval' ? '' : 'none'
      if (rowRandom) rowRandom.style.display = mode === 'random' ? '' : 'none'
      if (rowAutoAfter) rowAutoAfter.style.display = mode === 'off' ? 'none' : ''
      if (rowAutoPreview) rowAutoPreview.style.display = mode === 'off' ? 'none' : ''
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
    container.querySelector('#sh-toggle-auto-preview')?.addEventListener('change', (e) => {
      updateSettings({ autoPreviewPrompt: (e.target as HTMLInputElement).checked })
    })
  }

  // ── Native ImageGen ──

  let cachedNativeSettings: Record<string, any> | null = null
  let nativeSettingsFetchedAt = 0

  async function fetchNativeSettings(): Promise<Record<string, any>> {
    const now = Date.now()
    if (cachedNativeSettings !== null && (now - nativeSettingsFetchedAt) < NATIVE_SETTINGS_CACHE_MS) {
      return cachedNativeSettings
    }
    try {
      const resp = await fetch('/api/v1/settings/imageGeneration')
      if (resp.ok) {
        const data = await resp.json()
        const s = data?.value
        if (s && typeof s === 'object') {
          cachedNativeSettings = s
          nativeSettingsFetchedAt = now
          return s
        }
      }
    } catch { /* fall through */ }
    return cachedNativeSettings ?? {}
  }

  async function resolveLastMessageId(chatId: string): Promise<string | undefined> {
    try {
      const resp = await fetch(`/api/v1/chats/${chatId}/messages?tail=true&limit=1`)
      if (resp.ok) {
        const result = await resp.json()
        const messages = result?.data || result
        const last = Array.isArray(messages) ? messages[messages.length - 1] : null
        if (last?.id) return last.id
      }
    } catch { /* fall through */ }
    return undefined
  }

  async function callImageGen(chatId: string, overrides?: Record<string, any>): Promise<GenerationResult> {
    const native = await fetchNativeSettings()
    const body: Record<string, any> = {
      ...native,
      ...overrides,
      chatId,
      forceGeneration: settings?.forceGeneration ?? true,
    }

    if (body.outputTarget === 'attach_to_message' && !body.attachToMessageId) {
      const lastId = await resolveLastMessageId(chatId)
      if (lastId) body.attachToMessageId = lastId
    }

    const resp = await fetch('/api/v1/image-gen/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) throw new Error(await resp.text())
    const result = await resp.json()
    if (!result.generated) throw new Error(result.reason || 'Scene has not changed enough')
    if (!result.imageId) throw new Error('Image generated but not persisted')
    return {
      imageId: result.imageId,
      imageUrl: result.imageUrl || `/api/v1/image-gen/results/${result.imageId}`,
      handledByNative: !!result.message,
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

  // ── Post-generation handling ──

  function setGeneratingState(active: boolean) {
    generating = active
    updateFloatBtnState()
  }

  function handleGenerationResult(result: GenerationResult, messageId: string, chatId: string, isAuto: boolean) {
    setGeneratingState(false)
    resetAutoGenCounter()

    if (result.handledByNative) return

    const afterAction = isAuto ? settings?.autoGenerateAfter : settings?.afterGenerate
    if (afterAction === 'auto_insert') {
      ctx.sendToBackend({ type: 'insert_into_message', imageId: result.imageId, messageId, chatId })
    } else {
      openDestinationModal(result.imageId, result.imageUrl, messageId, chatId)
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

    setGeneratingState(true)

    try {
      const native = await fetchNativeSettings()
      const outputTarget = native.outputTarget || 'background'

      if (isAuto) {
        if (outputTarget === 'chat_attachment' || outputTarget === 'attach_to_message') {
          setGeneratingState(false)
          return
        }
      }

      // Prompt preview flow — mirrors native ImageGen panel behavior.
      // Manual generates always check the native toggle; auto-generates only
      // show the preview when the user has opted in via "Preview Prompt on Auto".
      const showPreview = native.previewPromptBeforeGenerate
        && (!isAuto || settings?.autoPreviewPrompt)
      if (showPreview) {
        try {
          const preview = await callPreviewPrompt(chatId)
          setGeneratingState(false)
          openPromptPreviewModal(preview.prompt, preview.negativePrompt, chatId, messageId)
        } catch (err: any) {
          setGeneratingState(false)
          showErrorModal(parseErrorMessage(err.message))
        }
        return
      }

      const result = await callImageGen(chatId)
      handleGenerationResult(result, messageId || '__last__', chatId, isAuto)
    } catch (err: any) {
      setGeneratingState(false)
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
    if (!settings) return
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
    if (!settings || settings.autoGenerate === 'off') return
    if (event.error || event.impersonateDraft) return
    autoGenCounter++
    if (autoGenCounter >= autoGenTarget) {
      triggerGenerate(event.messageId, event.chatId, true)
    }
  })

  // ── Modals ──

  function openLightbox(src: string) {
    const overlay = document.createElement('div')
    overlay.className = 'sh-lightbox'
    const img = document.createElement('img')
    img.src = src
    overlay.appendChild(img)
    overlay.addEventListener('click', () => overlay.remove())
    document.body.appendChild(overlay)
  }

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
    preview.addEventListener('click', () => openLightbox(imageUrl))
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

  function openPromptPreviewModal(initialPrompt: string, initialNegative: string, chatId: string, messageId?: string) {
    const modal = ctx.ui.showModal({ title: 'Preview & Edit Image Prompt', width: 640, persistent: true })
    const container = document.createElement('div')
    container.className = 'sh-modal-body'

    const subtitle = document.createElement('div')
    subtitle.className = 'sh-prompt-subtitle'
    subtitle.textContent = 'This is the prompt that will be sent to the image generator. Edit it freely \u2014 the parser will be skipped on confirm.'
    container.appendChild(subtitle)

    const promptField = document.createElement('div')
    promptField.className = 'sh-prompt-field'
    const promptLabel = document.createElement('label')
    promptLabel.className = 'sh-prompt-label'
    promptLabel.textContent = 'Prompt'
    const promptTextarea = document.createElement('textarea')
    promptTextarea.className = 'sh-prompt-textarea'
    promptTextarea.value = initialPrompt
    promptTextarea.placeholder = 'The final image prompt'
    promptField.appendChild(promptLabel)
    promptField.appendChild(promptTextarea)
    container.appendChild(promptField)

    const negField = document.createElement('div')
    negField.className = 'sh-prompt-field'
    const negLabel = document.createElement('label')
    negLabel.className = 'sh-prompt-label'
    negLabel.textContent = 'Negative Prompt'
    const negTextarea = document.createElement('textarea')
    negTextarea.className = 'sh-prompt-textarea sh-prompt-textarea-short'
    negTextarea.value = initialNegative
    negTextarea.placeholder = 'Optional negative prompt'
    negField.appendChild(negLabel)
    negField.appendChild(negTextarea)
    container.appendChild(negField)

    const errorEl = document.createElement('div')
    errorEl.className = 'sh-prompt-error'
    errorEl.style.display = 'none'
    container.appendChild(errorEl)

    const actions = document.createElement('div')
    actions.className = 'sh-prompt-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'sh-prompt-btn'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', () => modal.dismiss())

    const rerunBtn = document.createElement('button')
    rerunBtn.className = 'sh-prompt-btn'
    rerunBtn.textContent = 'Re-run parser'

    const generateBtn = document.createElement('button')
    generateBtn.className = 'sh-prompt-btn sh-prompt-btn-primary'
    generateBtn.textContent = 'Generate'

    function setBusy(busy: boolean) {
      rerunBtn.disabled = busy
      generateBtn.disabled = busy
      cancelBtn.disabled = busy
      rerunBtn.textContent = busy ? 'Regenerating\u2026' : 'Re-run parser'
    }

    rerunBtn.addEventListener('click', async () => {
      setBusy(true)
      errorEl.style.display = 'none'
      try {
        const result = await callPreviewPrompt(chatId)
        promptTextarea.value = result.prompt
        negTextarea.value = result.negativePrompt
      } catch (err: any) {
        errorEl.textContent = parseErrorMessage(err.message)
        errorEl.style.display = ''
      } finally {
        setBusy(false)
      }
    })

    generateBtn.addEventListener('click', async () => {
      const prompt = promptTextarea.value.trim()
      if (!prompt) {
        errorEl.textContent = 'Prompt cannot be empty'
        errorEl.style.display = ''
        return
      }
      modal.dismiss()

      setGeneratingState(true)
      try {
        const result = await callImageGen(chatId, {
          prompt,
          negativePrompt: negTextarea.value,
          skipParse: true,
        })
        handleGenerationResult(result, messageId || '__last__', chatId, false)
      } catch (err: any) {
        setGeneratingState(false)
        showErrorModal(parseErrorMessage(err.message))
      }
    })

    actions.appendChild(cancelBtn)
    actions.appendChild(rerunBtn)
    actions.appendChild(generateBtn)
    container.appendChild(actions)
    modal.root.appendChild(container)
  }

  // ── Backend messages ──

  const unsubBackend = ctx.onBackendMessage((payload: any) => {
    if (payload.type !== 'settings') return

    const incoming: Settings = payload.settings
    const isFirstLoad = settings === null
    const changed = isFirstLoad || Object.keys(incoming).some(
      key => (settings as any)[key] !== (incoming as any)[key]
    )

    if (changed) {
      const prev = settings ? { ...settings } : null
      applySettingsChange(prev, incoming)
      renderSettings()
    }
  })

  // ── Init ──

  ctx.sendToBackend({ type: 'request_settings' })

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
