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
  prompt: string
  negativePrompt: string
}

// ── Constants ──

const WIDGET_SIZES: Record<string, number> = { small: 44, medium: 56, large: 72 }
const DRAG_THRESHOLD_PX = 5
const DRAG_THRESHOLD_MS = 300

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
  let promptPreviewOpen = false
  const pendingLastMessageRequests = new Map<string, { resolve: (value: string | undefined) => void; timeout: ReturnType<typeof setTimeout> }>()
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
    const needed = ['chat_mutation', 'ui_panels', 'generation']
    const missing = needed.filter(p => !granted.includes(p))
    if (missing.length === 0) return
    ctx.ui.showConfirm({
      title: 'Permissions Required',
      message: `Shutter needs: ${missing.join(', ')}.`,
      variant: 'info',
      confirmLabel: 'Grant',
      cancelLabel: 'Not Now',
    }).then(({ confirmed }: { confirmed: boolean }) => {
      if (!confirmed) return
      ctx.permissions.request(missing).catch(() => {
        ctx.ui.showConfirm({
          title: 'Permissions Not Granted',
          message: 'Shutter needs these permissions for its widget and inline-generation automation. You can grant them later from Lumiverse extension settings.',
          variant: 'info',
          confirmLabel: 'OK',
          cancelLabel: 'Dismiss',
        })
      })
    }).catch(() => { /* user dismissed the prompt */ })
  })

  // ── Styles ──
  //
  // Settings selects use native <select> matching SettingsModal.module.css
  // Modal textareas and buttons match InputPromptModal.module.css
  // Image preview matches ImageGenPanel.module.css
  // Lightbox matches ImageLightbox.module.css

  const removeStyle = ctx.dom.addStyle(`
    /* ── Float widget ── */
    .sh-float-btn { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; border: none; background: var(--lumiverse-accent); color: var(--lumiverse-accent-fg); border-radius: 50%; cursor: pointer; transition: opacity var(--lumiverse-transition-fast); }
    .sh-float-btn:hover { opacity: 0.85; }
    .sh-float-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sh-float-btn svg { transition: transform 0.2s ease; }
    .sh-float-btn.sh-generating svg { animation: sh-spin 1.2s linear infinite; }
    @keyframes sh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

    /* ── Settings panel ── */
    .sh-settings { padding: 8px 16px 16px; }
    .sh-settings-title { font-size: calc(15px * var(--lumiverse-font-scale, 1)); font-weight: 600; color: var(--lumiverse-text); margin-bottom: 8px; }
    .sh-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; }
    .sh-setting-info { flex: 1; min-width: 0; }
    .sh-setting-label { font-size: calc(13px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text); }
    .sh-setting-desc { font-size: calc(11.5px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-muted); margin-top: 2px; }
    .sh-setting-control { flex-shrink: 0; }
    .sh-auto-section { margin-top: 10px; }
    .sh-range-row { display: flex; align-items: center; gap: 6px; }
    .sh-range-label { font-size: calc(12px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-muted); }

    /* Native <select> — matches SettingsModal.module.css */
    .sh-select { padding: 6px 10px; border-radius: 8px; background: var(--lumiverse-fill-subtle); border: 1px solid var(--lumiverse-border); color: var(--lumiverse-text); font-size: calc(13px * var(--lumiverse-font-scale, 1)); font-family: inherit; outline: none; cursor: pointer; }
    .sh-select:focus { border-color: var(--lumiverse-primary); }

    /* Native <input type="number"> — matches SettingsModal style */
    .sh-input-num { padding: 6px 10px; border-radius: 8px; background: var(--lumiverse-fill-subtle); border: 1px solid var(--lumiverse-border); color: var(--lumiverse-text); font-size: calc(13px * var(--lumiverse-font-scale, 1)); font-family: inherit; width: 54px; text-align: center; outline: none; }
    .sh-input-num:focus { border-color: var(--lumiverse-primary); }

    /* ── Destination modal ── */
    .sh-modal-body { padding: 8px 18px 16px; display: flex; flex-direction: column; gap: 12px; }

    /* Image preview — matches ImageGenPanel.module.css */
    .sh-preview { border: 1px solid var(--lumiverse-border); border-radius: 10px; overflow: hidden; cursor: zoom-in; background: var(--lumiverse-bg-elevated); }
    .sh-preview img { display: block; width: 100%; max-height: min(34vh, 280px); object-fit: contain; }

    /* Action buttons — matches FormComponents.module.css .btn */
    .sh-dest-choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .sh-dest-btn { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 7px 10px; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius, 8px); background: transparent; color: var(--lumiverse-text-muted); cursor: pointer; font-size: calc(13px * var(--lumiverse-font-scale, 1)); font-weight: 500; font-family: inherit; text-align: left; transition: background var(--lumiverse-transition-fast), color var(--lumiverse-transition-fast), border-color var(--lumiverse-transition-fast); }
    .sh-dest-btn:hover { background: var(--lumiverse-fill-subtle); color: var(--lumiverse-text); }
    .sh-dest-label { font-weight: 500; color: var(--lumiverse-text); }
    .sh-dest-desc { font-size: calc(11.5px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-dim); margin-top: 1px; line-height: 1.25; }
    @media (max-width: 560px) { .sh-dest-choices { grid-template-columns: 1fr; } }

    /* ── Lightbox — matches ImageLightbox.module.css ── */
    .sh-lightbox { position: fixed; inset: 0; width: var(--app-scaled-viewport-width, 100vw); height: var(--app-scaled-viewport-height, 100vh); z-index: 10003; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--lumiverse-modal-backdrop, rgba(0,0,0,0.8)); cursor: pointer; }
    [data-glass] .sh-lightbox { backdrop-filter: blur(var(--lcs-glass-soft-blur, 6px)); }
    .sh-lightbox img { max-width: 90vw; max-height: 90vh; object-fit: contain; border-radius: var(--lcs-radius-sm, 8px); cursor: default; }

    /* ── Prompt preview modal — matches InputPromptModal.module.css ── */
    .sh-prompt-subtitle { font-size: calc(12px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-dim); margin: 0; padding: 0; line-height: 1.5; }
    .sh-prompt-body { padding: 8px 18px 16px; display: flex; flex-direction: column; gap: 12px; }
    .sh-prompt-field { display: flex; flex-direction: column; gap: 4px; }
    .sh-prompt-label { font-size: calc(11px * var(--lumiverse-font-scale, 1)); font-weight: 600; color: var(--lumiverse-text-muted); text-transform: uppercase; letter-spacing: 0.5px; }

    /* Textareas — matches InputPromptModal.module.css .textarea */
    .sh-prompt-textarea { width: 100%; min-height: 120px; max-height: 200px; padding: 12px 14px; border-radius: var(--lcs-radius-sm, 8px); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-bg-dark); color: var(--lumiverse-text); font-size: calc(13px * var(--lumiverse-font-scale, 1)); line-height: 1.5; resize: vertical; font-family: inherit; transition: border-color var(--lumiverse-transition-fast); box-sizing: border-box; }
    .sh-prompt-textarea::placeholder { color: var(--lumiverse-text-dim); }
    .sh-prompt-textarea:focus { outline: none; border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5)); }
    .sh-prompt-textarea-short { min-height: 80px; }

    .sh-prompt-error { font-size: calc(12px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-danger, #e55); }

    /* Actions — matches InputPromptModal.module.css .actions / .btn* */
    .sh-prompt-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
    .sh-prompt-btn { padding: 8px 18px; border-radius: var(--lcs-radius-sm, 8px); font-size: calc(12.5px * var(--lumiverse-font-scale, 1)); font-weight: 600; font-family: inherit; cursor: pointer; border: 1px solid var(--lumiverse-border); transition: all var(--lumiverse-transition-fast); }
    .sh-prompt-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Cancel — matches .btnCancel */
    .sh-prompt-btn-cancel { background: transparent; color: var(--lumiverse-text-muted); }
    .sh-prompt-btn-cancel:hover:not(:disabled) { background: var(--lumiverse-fill-subtle, rgba(255,255,255,0.04)); color: var(--lumiverse-text); }

    /* Secondary (Re-run parser) — matches .btnSecondary / .btnSkip */
    .sh-prompt-btn-secondary { background: var(--lumiverse-bg-dark); color: var(--lumiverse-text-dim); }
    .sh-prompt-btn-secondary:hover:not(:disabled) { background: var(--lumiverse-bg-darker); color: var(--lumiverse-text); }

    /* Primary (Generate) — matches .btnSubmit */
    .sh-prompt-btn-primary { background: var(--lumiverse-primary-015, rgba(147,112,219,0.15)); color: var(--lumiverse-primary-text, #c4b5fd); border-color: var(--lumiverse-primary-020, rgba(147,112,219,0.2)); }
    .sh-prompt-btn-primary:hover:not(:disabled) { background: var(--lumiverse-primary-025, rgba(147,112,219,0.25)); border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5)); }
  `)

  // ── Settings panel (mount-once pattern) ──

  const settingsRoot = ctx.ui.mount('settings_extensions')
  settingsRoot.innerHTML = '<div style="padding:16px;font-size:13px;color:var(--lumiverse-text-muted)">Loading…</div>'

  // Track mounted shared component handles
  type SettingsHandles = {
    showFloatWidget: any
    toastOnInsert: any
    forceGeneration: any
    autoGenerateInterval: any
    autoGenerateRandomMin: any
    autoGenerateRandomMax: any
    autoPreviewPrompt: any
    autoSection: any
  }
  let handles: SettingsHandles | null = null
  let settingsMounting = false

  // Conditional rows that show/hide based on auto-generate mode
  let rowInterval: HTMLElement | null = null
  let rowRandom: HTMLElement | null = null
  let rowAutoAfter: HTMLElement | null = null
  let rowAutoPreview: HTMLElement | null = null

  // Native select element refs for syncing
  let selectWidgetSize: HTMLSelectElement | null = null
  let selectWidgetStyle: HTMLSelectElement | null = null
  let selectAfterGenerate: HTMLSelectElement | null = null
  let selectAutoGenerate: HTMLSelectElement | null = null
  let selectAutoGenerateAfter: HTMLSelectElement | null = null

  function makeRow(labelText: string, descText: string): { row: HTMLElement; controlSlot: HTMLElement } {
    const row = document.createElement('div')
    row.className = 'sh-setting-row'

    const info = document.createElement('div')
    info.className = 'sh-setting-info'
    const label = document.createElement('div')
    label.className = 'sh-setting-label'
    label.textContent = labelText
    const desc = document.createElement('div')
    desc.className = 'sh-setting-desc'
    desc.textContent = descText
    info.appendChild(label)
    info.appendChild(desc)

    const controlSlot = document.createElement('div')
    controlSlot.className = 'sh-setting-control'

    row.appendChild(info)
    row.appendChild(controlSlot)
    return { row, controlSlot }
  }

  function makeSelect(options: { value: string; label: string }[], current: string, onChange: (v: string) => void): HTMLSelectElement {
    const select = document.createElement('select')
    select.className = 'sh-select'
    for (const opt of options) {
      const el = document.createElement('option')
      el.value = opt.value
      el.textContent = opt.label
      if (opt.value === current) el.selected = true
      select.appendChild(el)
    }
    select.addEventListener('change', () => onChange(select.value))
    return select
  }

  function mountSettings(s: Settings) {
    settingsRoot.innerHTML = ''
    const container = document.createElement('div')
    container.className = 'sh-settings'

    // Settings title
    const title = document.createElement('div')
    title.className = 'sh-settings-title'
    title.textContent = 'Shutter'
    container.appendChild(title)

    // ── General settings ──

    // Floating Widget toggle
    const floatRow = makeRow('Floating Widget', 'Show a quick-access generate widget on screen')
    container.appendChild(floatRow.row)
    const showFloatWidget = ctx.components.mountSwitch(floatRow.controlSlot, {
      checked: s.showFloatWidget,
      onChange: (on: boolean) => updateSettings({ showFloatWidget: on }),
    })

    // Widget Size — native <select>
    const sizeRow = makeRow('Widget Size', 'Size of the floating button')
    container.appendChild(sizeRow.row)
    selectWidgetSize = makeSelect(
      [{ value: 'small', label: 'Small (44px)' }, { value: 'medium', label: 'Medium (56px)' }, { value: 'large', label: 'Large (72px)' }],
      s.widgetSize,
      (v) => updateSettings({ widgetSize: v as Settings['widgetSize'] }),
    )
    sizeRow.controlSlot.appendChild(selectWidgetSize)

    // Widget Style — native <select>
    const styleRow = makeRow('Widget Style', 'Icon style for the floating button')
    container.appendChild(styleRow.row)
    selectWidgetStyle = makeSelect(
      [{ value: 'color', label: 'Colour' }, { value: 'mono', label: 'Monochrome' }],
      s.widgetStyle,
      (v) => updateSettings({ widgetStyle: v as Settings['widgetStyle'] }),
    )
    styleRow.controlSlot.appendChild(selectWidgetStyle)

    // Toast on Insert
    const toastRow = makeRow('Toast on Insert', 'Show a notification when an image is inserted into a message')
    container.appendChild(toastRow.row)
    const toastOnInsert = ctx.components.mountSwitch(toastRow.controlSlot, {
      checked: s.toastOnInsert,
      onChange: (on: boolean) => updateSettings({ toastOnInsert: on }),
    })

    // Force Generation
    const forceRow = makeRow('Force Generation', 'Always request generation regardless of scene changes. When off, Lumiverse may skip generation if the scene hasn\'t changed enough.')
    container.appendChild(forceRow.row)
    const forceGeneration = ctx.components.mountSwitch(forceRow.controlSlot, {
      checked: s.forceGeneration,
      onChange: (on: boolean) => updateSettings({ forceGeneration: on }),
    })

    // After Generate — native <select>
    const afterRow = makeRow('After Generate', 'What to do after a manual generation. Skipped when ImageGen is set to Insert into Chat or Attach to Last Message.')
    container.appendChild(afterRow.row)
    selectAfterGenerate = makeSelect(
      [{ value: 'ask_to_insert', label: 'Ask to insert' }, { value: 'auto_insert', label: 'Auto insert' }],
      s.afterGenerate,
      (v) => updateSettings({ afterGenerate: v as Settings['afterGenerate'] }),
    )
    afterRow.controlSlot.appendChild(selectAfterGenerate)

    // ── Auto Generate section (shared collapsible) ──

    const autoSectionSlot = document.createElement('div')
    autoSectionSlot.className = 'sh-auto-section'
    container.appendChild(autoSectionSlot)

    const autoSection = ctx.components.mountCollapsibleSection(autoSectionSlot, {
      title: 'Auto Generate',
      defaultExpanded: s.autoGenerate !== 'off',
    })

    // Auto Generate Mode — native <select>
    const autoModeRow = makeRow('Mode', 'Automatically generate after AI responses. Skipped when ImageGen is set to Insert into Chat or Attach to Last Message.')
    autoSection.body.appendChild(autoModeRow.row)
    selectAutoGenerate = makeSelect(
      [{ value: 'off', label: 'Off' }, { value: 'every', label: 'Every message' }, { value: 'interval', label: 'Every X messages' }, { value: 'random', label: 'Random interval' }],
      s.autoGenerate,
      (v) => {
        const mode = v as Settings['autoGenerate']
        updateSettings({ autoGenerate: mode })
        updateAutoRowVisibility(mode)
      },
    )
    autoModeRow.controlSlot.appendChild(selectAutoGenerate)

    // Interval row — shared number stepper
    const intervalRow = makeRow('Interval', 'Generate every X AI messages')
    autoSection.body.appendChild(intervalRow.row)
    rowInterval = intervalRow.row
    const autoGenerateInterval = ctx.components.mountNumberStepper(intervalRow.controlSlot, {
      value: s.autoGenerateInterval,
      min: 1,
      max: 99,
      step: 1,
      onChange: (v: number | null) => { if (v !== null) updateSettings({ autoGenerateInterval: v }) },
    })

    // Random range row — shared number steppers
    const randomRow = makeRow('Random Range', 'Generate randomly between X and Y AI messages')
    autoSection.body.appendChild(randomRow.row)
    rowRandom = randomRow.row
    const rangeContainer = document.createElement('div')
    rangeContainer.className = 'sh-range-row'
    const minSlot = document.createElement('div')
    const rangeSep = document.createElement('span')
    rangeSep.className = 'sh-range-label'
    rangeSep.textContent = 'to'
    const maxSlot = document.createElement('div')
    rangeContainer.appendChild(minSlot)
    rangeContainer.appendChild(rangeSep)
    rangeContainer.appendChild(maxSlot)
    randomRow.controlSlot.appendChild(rangeContainer)

    const autoGenerateRandomMin = ctx.components.mountNumberStepper(minSlot, {
      value: s.autoGenerateRandomMin,
      min: 1, max: 99, step: 1,
      onChange: (v: number | null) => { if (v !== null) updateSettings({ autoGenerateRandomMin: v }) },
    })
    const autoGenerateRandomMax = ctx.components.mountNumberStepper(maxSlot, {
      value: s.autoGenerateRandomMax,
      min: 1, max: 99, step: 1,
      onChange: (v: number | null) => { if (v !== null) updateSettings({ autoGenerateRandomMax: v }) },
    })

    // After Auto Generate — native <select>
    const autoAfterRow = makeRow('After Auto Generate', 'What to do after an automatic generation')
    autoSection.body.appendChild(autoAfterRow.row)
    rowAutoAfter = autoAfterRow.row
    selectAutoGenerateAfter = makeSelect(
      [{ value: 'auto_insert', label: 'Auto insert' }, { value: 'ask_to_insert', label: 'Ask to insert' }],
      s.autoGenerateAfter,
      (v) => updateSettings({ autoGenerateAfter: v as Settings['autoGenerateAfter'] }),
    )
    autoAfterRow.controlSlot.appendChild(selectAutoGenerateAfter)

    // Preview Prompt on Auto — shared switch
    const autoPreviewRow = makeRow('Preview Prompt on Auto', 'Show the prompt preview before auto-generated images. Requires "Preview Prompt Before Generating" to be enabled in native ImageGen settings.')
    autoSection.body.appendChild(autoPreviewRow.row)
    rowAutoPreview = autoPreviewRow.row
    const autoPreviewPrompt = ctx.components.mountSwitch(autoPreviewRow.controlSlot, {
      checked: s.autoPreviewPrompt,
      onChange: (on: boolean) => updateSettings({ autoPreviewPrompt: on }),
    })

    settingsRoot.appendChild(container)

    // Set initial visibility of conditional rows
    updateAutoRowVisibility(s.autoGenerate)

    handles = {
      showFloatWidget,
      toastOnInsert,
      forceGeneration,
      autoGenerateInterval,
      autoGenerateRandomMin,
      autoGenerateRandomMax,
      autoPreviewPrompt,
      autoSection,
    }
  }

  function updateAutoRowVisibility(mode: Settings['autoGenerate']) {
    const showInterval = mode === 'interval'
    const showRandom = mode === 'random'
    const autoActive = mode !== 'off'

    if (rowInterval) rowInterval.style.display = showInterval ? '' : 'none'
    if (rowRandom) rowRandom.style.display = showRandom ? '' : 'none'
    if (rowAutoAfter) rowAutoAfter.style.display = autoActive ? '' : 'none'
    if (rowAutoPreview) rowAutoPreview.style.display = autoActive ? '' : 'none'
  }

  function destroySettingsHandles() {
    if (!handles) return
    handles.showFloatWidget.destroy()
    handles.toastOnInsert.destroy()
    handles.forceGeneration.destroy()
    handles.autoGenerateInterval.destroy()
    handles.autoGenerateRandomMin.destroy()
    handles.autoGenerateRandomMax.destroy()
    handles.autoPreviewPrompt.destroy()
    handles.autoSection.destroy()
    handles = null
    rowInterval = null
    rowRandom = null
    rowAutoAfter = null
    rowAutoPreview = null
    selectWidgetSize = null
    selectWidgetStyle = null
    selectAfterGenerate = null
    selectAutoGenerate = null
    selectAutoGenerateAfter = null
  }

  function syncSettingsToHandles(s: Settings) {
    if (!handles) return

    // Shared components — use update()
    handles.showFloatWidget.update({ checked: s.showFloatWidget })
    handles.toastOnInsert.update({ checked: s.toastOnInsert })
    handles.forceGeneration.update({ checked: s.forceGeneration })
    handles.autoGenerateInterval.update({ value: s.autoGenerateInterval })
    handles.autoGenerateRandomMin.update({ value: s.autoGenerateRandomMin })
    handles.autoGenerateRandomMax.update({ value: s.autoGenerateRandomMax })
    handles.autoPreviewPrompt.update({ checked: s.autoPreviewPrompt })

    // Native selects — set .value directly
    if (selectWidgetSize) selectWidgetSize.value = s.widgetSize
    if (selectWidgetStyle) selectWidgetStyle.value = s.widgetStyle
    if (selectAfterGenerate) selectAfterGenerate.value = s.afterGenerate
    if (selectAutoGenerate) selectAutoGenerate.value = s.autoGenerate
    if (selectAutoGenerateAfter) selectAutoGenerateAfter.value = s.autoGenerateAfter

    updateAutoRowVisibility(s.autoGenerate)
  }

  // ── Native ImageGen ──

  let cachedNativeSettings: Record<string, any> | null = null
  let nativeSettingsFetchedAt = 0

  async function fetchNativeSettings(): Promise<Record<string, any>> {
    try {
      const resp = await fetch('/api/v1/settings/imageGeneration')
      if (!resp.ok) throw new Error(await resp.text())

      const data = await resp.json()
      const s = data?.value
      if (!s || typeof s !== 'object') throw new Error('Native ImageGen settings were not returned.')

      cachedNativeSettings = s
      nativeSettingsFetchedAt = Date.now()
      return s
    } catch (err: any) {
      if (cachedNativeSettings !== null) return cachedNativeSettings
      const details = err?.message ? ` ${parseErrorMessage(err.message)}` : ''
      throw new Error(`Native ImageGen settings could not be loaded. Make sure Lumiverse ImageGen is available and configured.${details}`)
    }
  }

  async function resolveLastMessageId(chatId: string): Promise<string | undefined> {
    const requestId = `last-message-${Date.now()}-${Math.random().toString(36).slice(2)}`

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingLastMessageRequests.delete(requestId)
        resolve(undefined)
      }, 5000)

      pendingLastMessageRequests.set(requestId, { resolve, timeout })
      ctx.sendToBackend({ type: 'resolve_last_message_id', requestId, chatId })
    })
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
      prompt: typeof result.prompt === 'string' ? result.prompt : (typeof overrides?.prompt === 'string' ? overrides.prompt : ''),
      negativePrompt: typeof result.negativePrompt === 'string' ? result.negativePrompt : (typeof overrides?.negativePrompt === 'string' ? overrides.negativePrompt : ''),
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
      openDestinationModal(result.imageId, result.imageUrl, messageId, chatId, result.prompt, result.negativePrompt, isAuto)
    }
  }

  // ── Generate ──

  async function triggerGenerate(messageId?: string, chatId?: string, isAuto = false) {
    if (generating || promptPreviewOpen) return

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
        // Shutter's automation only owns inline/manual insertion. If native
        // ImageGen is configured to insert into chat or attach to the last
        // message, let the native path handle that mode instead. Do not skip
        // merely because native Auto-Generate is enabled: many users leave
        // that setting on while using Shutter for inline/background automation.
        if (outputTarget === 'chat_attachment' || outputTarget === 'attach_to_message') {
          setGeneratingState(false)
          return
        }
      }

      const showPreview = native.previewPromptBeforeGenerate
        && (!isAuto || settings?.autoPreviewPrompt)
      if (showPreview) {
        try {
          const preview = await callPreviewPrompt(chatId)
          setGeneratingState(false)
          openPromptPreviewModal(preview.prompt, preview.negativePrompt, chatId, messageId, isAuto)
        } catch (err: any) {
          setGeneratingState(false)
          if (!isAuto) showErrorModal(parseErrorMessage(err.message))
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

  // ── Chat visibility: CHAT_SWITCHED event ──

  const unsubChatSwitched = ctx.events.on('CHAT_SWITCHED', (event: any) => {
    if (!floatWidget) return
    floatWidget.setVisible(event.chatId !== null)
  })

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

  // ── Lightbox state (for cleanup) ──

  let activeLightbox: { overlay: HTMLElement; escHandler: (e: KeyboardEvent) => void } | null = null

  function dismissLightbox() {
    if (!activeLightbox) return
    document.removeEventListener('keydown', activeLightbox.escHandler)
    activeLightbox.overlay.remove()
    activeLightbox = null
  }

  function openLightbox(src: string) {
    // Dismiss any existing lightbox first
    dismissLightbox()

    const overlay = document.createElement('div')
    overlay.className = 'sh-lightbox'
    const img = document.createElement('img')
    img.src = src
    overlay.appendChild(img)

    // Mousedown-origin guard — matches native ImageLightbox behavior.
    // Only close if both mousedown and click land on the backdrop itself.
    let mouseDownTarget: EventTarget | null = null
    overlay.addEventListener('mousedown', (e) => {
      mouseDownTarget = e.target
    })
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && mouseDownTarget === overlay) dismissLightbox()
    })

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissLightbox()
    }
    document.addEventListener('keydown', escHandler)

    activeLightbox = { overlay, escHandler }
    document.body.appendChild(overlay)
  }

  function makeDestBtn(label: string, desc: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'sh-dest-btn'
    btn.innerHTML = `<div><div class="sh-dest-label">${label}</div><div class="sh-dest-desc">${desc}</div></div>`
    btn.addEventListener('click', onClick)
    return btn
  }

  function openDestinationModal(imageId: string, imageUrl: string, messageId: string, chatId: string, prompt: string, negativePrompt: string, isAuto: boolean) {
    const modal = ctx.ui.showModal({ title: 'Image Generated', width: 560, persistent: true })
    const container = document.createElement('div')
    container.className = 'sh-modal-body'

    const previewWrap = document.createElement('div')
    previewWrap.className = 'sh-preview'
    const preview = document.createElement('img')
    preview.src = imageUrl
    preview.addEventListener('click', () => openLightbox(imageUrl))
    previewWrap.appendChild(preview)
    container.appendChild(previewWrap)

    const choices = document.createElement('div')
    choices.className = 'sh-dest-choices'
    choices.appendChild(makeDestBtn('Insert', 'Append to message', () => {
      ctx.sendToBackend({ type: 'insert_into_message', imageId, messageId, chatId })
      modal.dismiss()
    }))
    choices.appendChild(makeDestBtn('Regenerate Image', 'Use same prompts', async () => {
      const resolvedPrompt = prompt.trim()
      if (!resolvedPrompt) {
        modal.dismiss()
        showErrorModal('Cannot regenerate because the resolved prompt was not returned by native ImageGen.')
        return
      }

      modal.dismiss()
      setGeneratingState(true)
      try {
        const result = await callImageGen(chatId, {
          prompt: resolvedPrompt,
          negativePrompt,
          skipParse: true,
        })
        handleGenerationResult(result, messageId, chatId, isAuto)
      } catch (err: any) {
        setGeneratingState(false)
        showErrorModal(parseErrorMessage(err.message))
      }
    }))
    choices.appendChild(makeDestBtn('Start again', 'Rebuild prompt', () => {
      modal.dismiss()
      triggerGenerate(messageId, chatId, isAuto)
    }))
    choices.appendChild(makeDestBtn('Done', 'Close modal', () => {
      modal.dismiss()
    }))
    container.appendChild(choices)
    modal.root.appendChild(container)
  }

  function showErrorModal(message: string) {
    ctx.ui.showConfirm({
      title: 'Generation Failed',
      message,
      variant: 'danger',
      confirmLabel: 'OK',
      cancelLabel: 'Dismiss',
    })
  }

  function openPromptPreviewModal(initialPrompt: string, initialNegative: string, chatId: string, messageId?: string, isAuto = false) {
    if (promptPreviewOpen) return
    promptPreviewOpen = true
    const modal = ctx.ui.showModal({ title: 'Preview & Edit Image Prompt', width: 640, persistent: true })
    function closePromptModal() {
      promptPreviewOpen = false
      modal.dismiss()
    }
    const container = document.createElement('div')
    container.className = 'sh-prompt-body'

    const subtitle = document.createElement('div')
    subtitle.className = 'sh-prompt-subtitle'
    subtitle.textContent = 'This is the prompt that will be sent to the image generator. Edit it freely \u2014 the parser will be skipped on confirm.'
    container.appendChild(subtitle)

    // Prompt field — native textarea matching InputPromptModal
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

    // Negative prompt field
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
    cancelBtn.className = 'sh-prompt-btn sh-prompt-btn-cancel'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', () => closePromptModal())

    const rerunBtn = document.createElement('button')
    rerunBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary'
    rerunBtn.textContent = 'Re-run parser'

    const generateBtn = document.createElement('button')
    generateBtn.className = 'sh-prompt-btn sh-prompt-btn-primary'
    generateBtn.textContent = 'Generate'

    function setBusy(busy: boolean) {
      rerunBtn.disabled = busy
      generateBtn.disabled = busy
      cancelBtn.disabled = busy
      promptTextarea.disabled = busy
      negTextarea.disabled = busy
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
      closePromptModal()

      setGeneratingState(true)
      try {
        const result = await callImageGen(chatId, {
          prompt,
          negativePrompt: negTextarea.value,
          skipParse: true,
        })
        handleGenerationResult(result, messageId || '__last__', chatId, isAuto)
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
    if (payload.type === 'last_message_id') {
      const pending = pendingLastMessageRequests.get(payload.requestId)
      if (!pending) return
      clearTimeout(pending.timeout)
      pendingLastMessageRequests.delete(payload.requestId)
      pending.resolve(typeof payload.messageId === 'string' ? payload.messageId : undefined)
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

      if (!handles) {
        if (settingsMounting) return
        settingsMounting = true
        mountSettings(incoming)
        settingsMounting = false
      } else {
        syncSettingsToHandles(incoming)
      }
    }
  })

  // ── Init ──

  ctx.sendToBackend({ type: 'request_settings' })

  // ── Cleanup ──

  return () => {
    for (const [requestId, pending] of pendingLastMessageRequests) {
      clearTimeout(pending.timeout)
      pending.resolve(undefined)
      pendingLastMessageRequests.delete(requestId)
    }
    unsubBackend()
    unsubCharMsg()
    unsubChatSwitched()
    inputAction.destroy()
    destroyFloatWidget()
    destroySettingsHandles()
    dismissLightbox()
    removeStyle()

    ctx.dom.cleanup()
  }
}
