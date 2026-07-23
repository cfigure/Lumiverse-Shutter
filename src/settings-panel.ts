// The extension settings panel (mount-once pattern): host shared components
// (switches, steppers, collapsible section) tracked via a handles record,
// native <select>/<input> refs synced by value, and conditional row
// visibility. Moved whole from frontend.ts.
//
// Ownership: the entry file owns settings STATE and the optimistic-update
// flow; this module owns the panel DOM and the mounted component handles.
// deps.updateSettings is the entry's optimistic updater — every control
// change routes through it, and validated settings echo back through
// applyIncoming.

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { ICON_SETS, type ShutterIconId } from './icons'
import { clampShutterImageWidth, type Settings } from './settings'

export function createSettingsPanel(deps: {
  ctx: SpindleFrontendContext
  updateSettings: (patch: Partial<Settings>) => void
  hasPermission: (permission: string) => boolean
}) {
  const { ctx } = deps

  // ── Settings panel (mount-once pattern) ──

  const settingsRoot = ctx.ui.mount('settings_extensions')
  settingsRoot.innerHTML = '<div style="padding:16px;font-size:13px;color:var(--lumiverse-text-muted)">Loading…</div>'

  // Track mounted shared component handles
  type SettingsHandles = {
    showFloatWidget: any
    toastOnInsert: any
    generationHistory: any
    swipeToRegenerate: any
    removeImageTagsFromContext: any
    showPromptInLightbox: any
    autoGenerateInterval: any
    autoGenerateRandomMin: any
    autoGenerateRandomMax: any
    autoPreviewPrompt: any
    autoSection: any
  }
  let handles: SettingsHandles | null = null
  let settingsMounting = false

  // Conditional rows that show/hide based on other settings
  let rowWidgetSize: HTMLElement | null = null
  let rowWidgetStyle: HTMLElement | null = null
  let rowSwipeToRegenerate: HTMLElement | null = null
  let rowInterval: HTMLElement | null = null
  let rowRandom: HTMLElement | null = null
  let rowAutoAfter: HTMLElement | null = null
  let rowAutoPreview: HTMLElement | null = null
  let rowShutterImageWidth: HTMLElement | null = null
  let rowShutterImageAlign: HTMLElement | null = null

  // Native select element refs for syncing
  let selectWidgetSize: HTMLSelectElement | null = null
  let selectWidgetStyle: HTMLSelectElement | null = null
  let selectIconTheme: HTMLSelectElement | null = null
  let selectAfterGenerate: HTMLSelectElement | null = null
  let selectAutoGenerate: HTMLSelectElement | null = null
  let selectAutoGenerateAfter: HTMLSelectElement | null = null
  let selectDefaultAction: HTMLSelectElement | null = null
  let selectDeleteConfirmation: HTMLSelectElement | null = null
  let selectShutterImageLayout: HTMLSelectElement | null = null
  let inputShutterImageWidth: HTMLInputElement | null = null
  let selectShutterImageAlign: HTMLSelectElement | null = null

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

  function makePercentInput(current: number, onChange: (v: number) => void): HTMLInputElement {
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '1'
    input.max = '100'
    input.step = '0.1'
    input.inputMode = 'decimal'
    input.className = 'sh-select sh-percent-input'
    input.value = String(clampShutterImageWidth(current))

    const commit = () => {
      const next = clampShutterImageWidth(Number(input.value))
      input.value = String(next)
      onChange(next)
    }

    input.addEventListener('change', commit)
    input.addEventListener('blur', commit)
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') input.blur()
    })
    return input
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
    const floatRow = makeRow('Floating Widget', 'Show a quick-access generate widget on screen.')
    container.appendChild(floatRow.row)
    const showFloatWidget = ctx.components.mountSwitch(floatRow.controlSlot, {
      checked: s.showFloatWidget,
      onChange: (on: boolean) => {
        deps.updateSettings({ showFloatWidget: on })
        updateFloatingWidgetRowVisibility(on)
      },
    })

    // Widget Size — native <select>
    const sizeRow = makeRow('Widget Size', 'Size of the floating button.')
    container.appendChild(sizeRow.row)
    rowWidgetSize = sizeRow.row
    selectWidgetSize = makeSelect(
      [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }, { value: 'xlarge', label: 'XL' }],
      s.widgetSize,
      (v) => deps.updateSettings({ widgetSize: v as Settings['widgetSize'] }),
    )
    sizeRow.controlSlot.appendChild(selectWidgetSize)

    // Widget Style — native <select>
    const styleRow = makeRow('Widget Style', 'Icon style for the floating button.')
    container.appendChild(styleRow.row)
    rowWidgetStyle = styleRow.row
    selectWidgetStyle = makeSelect(
      [{ value: 'color', label: 'Colour' }, { value: 'mono', label: 'Monochrome' }],
      s.widgetStyle,
      (v) => deps.updateSettings({ widgetStyle: v as Settings['widgetStyle'] }),
    )
    styleRow.controlSlot.appendChild(selectWidgetStyle)

    // Icon Theme — native <select>
    const iconRow = makeRow('Icon', 'Choose the icon used for the floating widget and input bar action.')
    container.appendChild(iconRow.row)
    selectIconTheme = makeSelect(
      (Object.entries(ICON_SETS) as [ShutterIconId, (typeof ICON_SETS)[ShutterIconId]][])
        .map(([value, icon]) => ({ value, label: icon.label })),
      s.iconTheme,
      (v) => deps.updateSettings({ iconTheme: v as ShutterIconId }),
    )
    iconRow.controlSlot.appendChild(selectIconTheme)

    // Generation History (parent)
    const historyRow = makeRow('Generation History', 'Browse every version generated with Regenerate Image in the result modal. Insert or regenerate any of them — a new generation or Rebuild Prompt starts a fresh set.')
    container.appendChild(historyRow.row)
    const generationHistory = ctx.components.mountSwitch(historyRow.controlSlot, {
      checked: s.generationHistory,
      onChange: (on: boolean) => {
        deps.updateSettings({ generationHistory: on })
        updateGenerationHistoryRowVisibility(on)
      },
    })

    // Swipe to Regenerate (child — hidden while Generation History is off)
    const swipeRegenRow = makeRow('Swipe to Regenerate', 'Swipe past the last image (mobile), press the right arrow key (desktop), or tap the chevron to generate another with the same prompt.')
    container.appendChild(swipeRegenRow.row)
    rowSwipeToRegenerate = swipeRegenRow.row
    const swipeToRegenerate = ctx.components.mountSwitch(swipeRegenRow.controlSlot, {
      checked: s.swipeToRegenerate,
      onChange: (on: boolean) => deps.updateSettings({ swipeToRegenerate: on }),
    })

    // Toast on Insert
    const toastRow = makeRow('Toast on Insert', 'Show a notification when an image is inserted into a message.')
    container.appendChild(toastRow.row)
    const toastOnInsert = ctx.components.mountSwitch(toastRow.controlSlot, {
      checked: s.toastOnInsert,
      onChange: (on: boolean) => deps.updateSettings({ toastOnInsert: on }),
    })

    const insertionDivider = document.createElement('div')
    insertionDivider.className = 'sh-settings-divider'
    container.appendChild(insertionDivider)

    const insertionNote = document.createElement('div')
    insertionNote.className = 'sh-settings-note'
    insertionNote.textContent = 'The following settings apply only when Shutter handles insertion. They have no effect when ImageGen is set to Insert into Chat or Attach to Last Message.'
    container.appendChild(insertionNote)

    // Remove Image Tags from Context
    const hasInterceptorPermission = deps.hasPermission('interceptor')
    const imageTagContextDescription =
      'When enabled, Shutter removes inline-generated ![shutter](...) Markdown tags from prompts sent to the LLM.'
    const imageTagContextRow = makeRow('Remove Image Tags from Context', imageTagContextDescription)
    container.appendChild(imageTagContextRow.row)
    const removeImageTagsFromContext = ctx.components.mountSwitch(imageTagContextRow.controlSlot, {
      checked: s.removeImageTagsFromContext,
      disabled: !hasInterceptorPermission,
      onChange: (on: boolean) => deps.updateSettings({ removeImageTagsFromContext: on }),
    })

    // Inline Shutter image layout — native <select> + typeable percentage input
    const imageLayoutRow = makeRow(
      'Shutter Image Layout',
      'Optionally resize and align inline Shutter Markdown images. Leave off if you already style Shutter images with custom CSS.',
    )
    container.appendChild(imageLayoutRow.row)
    selectShutterImageLayout = makeSelect(
      [{ value: 'off', label: 'Off' }, { value: 'custom', label: 'Custom' }],
      s.shutterImageLayout,
      (v) => {
        const mode = v as Settings['shutterImageLayout']
        deps.updateSettings({ shutterImageLayout: mode })
        updateShutterImageLayoutVisibility(mode)
      },
    )
    imageLayoutRow.controlSlot.appendChild(selectShutterImageLayout)

    const imageWidthRow = makeRow('Image Width', 'Width of inline Shutter images, as a percentage of the message area.')
    container.appendChild(imageWidthRow.row)
    rowShutterImageWidth = imageWidthRow.row
    const widthControl = document.createElement('div')
    widthControl.className = 'sh-percent-control'
    inputShutterImageWidth = makePercentInput(s.shutterImageWidth, (v) => deps.updateSettings({ shutterImageWidth: v }))
    const widthSuffix = document.createElement('span')
    widthSuffix.className = 'sh-percent-suffix'
    widthSuffix.textContent = '%'
    widthControl.appendChild(inputShutterImageWidth)
    widthControl.appendChild(widthSuffix)
    imageWidthRow.controlSlot.appendChild(widthControl)

    const imageAlignRow = makeRow('Image Alignment', 'Alignment for inline Shutter images when width is below 100%.')
    container.appendChild(imageAlignRow.row)
    rowShutterImageAlign = imageAlignRow.row
    selectShutterImageAlign = makeSelect(
      [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }],
      s.shutterImageAlign,
      (v) => deps.updateSettings({ shutterImageAlign: v as Settings['shutterImageAlign'] }),
    )
    imageAlignRow.controlSlot.appendChild(selectShutterImageAlign)

    // Show Prompt in Lightbox (requires app_manipulation)
    const hasAppManipulationPermission = deps.hasPermission('app_manipulation')
    const lightboxPromptRow = makeRow(
      'Show Prompt in Lightbox',
      'Show the generation prompt below Shutter images opened in the native image viewer. Reads provider metadata from Shutter-tagged images and does not store prompt history.',
    )
    container.appendChild(lightboxPromptRow.row)
    const showPromptInLightbox = ctx.components.mountSwitch(lightboxPromptRow.controlSlot, {
      checked: s.showPromptInLightbox,
      disabled: !hasAppManipulationPermission,
      onChange: (on: boolean) => deps.updateSettings({ showPromptInLightbox: on }),
    })

    // After Generation — native <select>
    const afterRow = makeRow('After Generation', 'What to do after a manual generation.')
    container.appendChild(afterRow.row)
    selectAfterGenerate = makeSelect(
      [{ value: 'ask_to_insert', label: 'Ask to insert' }, { value: 'auto_insert', label: 'Auto insert' }],
      s.afterGenerate,
      (v) => deps.updateSettings({ afterGenerate: v as Settings['afterGenerate'] }),
    )
    afterRow.controlSlot.appendChild(selectAfterGenerate)

    // Default Action — native <select>
    const defaultActionRow = makeRow('Default Widget Action', 'What pressing the widget or the input bar action does. Append inserts a new image; Replace swaps out the last Shutter image first.')
    container.appendChild(defaultActionRow.row)
    selectDefaultAction = makeSelect(
      [{ value: 'append', label: 'Append' }, { value: 'replace', label: 'Replace' }],
      s.defaultAction,
      (v) => deps.updateSettings({ defaultAction: v as Settings['defaultAction'] }),
    )
    defaultActionRow.controlSlot.appendChild(selectDefaultAction)

    // Delete Confirmation — native <select>
    const deleteConfirmRow = makeRow('Remove Confirmation', 'When to show a confirmation before removing images.')
    container.appendChild(deleteConfirmRow.row)
    selectDeleteConfirmation = makeSelect(
      [{ value: 'never', label: 'Never' }, { value: 'bulk_only', label: 'Bulk only' }, { value: 'always', label: 'Always' }],
      s.deleteConfirmation,
      (v) => deps.updateSettings({ deleteConfirmation: v as Settings['deleteConfirmation'] }),
    )
    deleteConfirmRow.controlSlot.appendChild(selectDeleteConfirmation)

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
        deps.updateSettings({ autoGenerate: mode })
        updateAutoRowVisibility(mode)
      },
    )
    autoModeRow.controlSlot.appendChild(selectAutoGenerate)

    // Interval row — shared number stepper
    const intervalRow = makeRow('Interval', 'Generate every X AI messages.')
    autoSection.body.appendChild(intervalRow.row)
    rowInterval = intervalRow.row
    const autoGenerateInterval = ctx.components.mountNumberStepper(intervalRow.controlSlot, {
      value: s.autoGenerateInterval,
      min: 1,
      max: 99,
      step: 1,
      onChange: (v: number | null) => { if (v !== null) deps.updateSettings({ autoGenerateInterval: v }) },
    })

    // Random range row — shared number steppers
    const randomRow = makeRow('Random Range', 'Generate randomly between X and Y AI messages.')
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
      onChange: (v: number | null) => { if (v !== null) deps.updateSettings({ autoGenerateRandomMin: v }) },
    })
    const autoGenerateRandomMax = ctx.components.mountNumberStepper(maxSlot, {
      value: s.autoGenerateRandomMax,
      min: 1, max: 99, step: 1,
      onChange: (v: number | null) => { if (v !== null) deps.updateSettings({ autoGenerateRandomMax: v }) },
    })

    // After Auto Generate — native <select>
    const autoAfterRow = makeRow('After Auto Generate', 'What to do after an automatic generation.')
    autoSection.body.appendChild(autoAfterRow.row)
    rowAutoAfter = autoAfterRow.row
    selectAutoGenerateAfter = makeSelect(
      [{ value: 'auto_insert', label: 'Auto insert' }, { value: 'ask_to_insert', label: 'Ask to insert' }],
      s.autoGenerateAfter,
      (v) => deps.updateSettings({ autoGenerateAfter: v as Settings['autoGenerateAfter'] }),
    )
    autoAfterRow.controlSlot.appendChild(selectAutoGenerateAfter)

    // Preview Prompt on Auto — shared switch
    const autoPreviewRow = makeRow('Preview Prompt on Auto', 'Show the prompt preview before auto-generated images. Requires "Preview Prompt Before Generating" to be enabled in native ImageGen settings.')
    autoSection.body.appendChild(autoPreviewRow.row)
    rowAutoPreview = autoPreviewRow.row
    const autoPreviewPrompt = ctx.components.mountSwitch(autoPreviewRow.controlSlot, {
      checked: s.autoPreviewPrompt,
      onChange: (on: boolean) => deps.updateSettings({ autoPreviewPrompt: on }),
    })

    settingsRoot.appendChild(container)

    // Set initial visibility of conditional rows
    updateFloatingWidgetRowVisibility(s.showFloatWidget)
    updateShutterImageLayoutVisibility(s.shutterImageLayout)
    updateAutoRowVisibility(s.autoGenerate)
    updateGenerationHistoryRowVisibility(s.generationHistory)

    handles = {
      showFloatWidget,
      toastOnInsert,
      generationHistory,
      swipeToRegenerate,
      removeImageTagsFromContext,
      showPromptInLightbox,
      autoGenerateInterval,
      autoGenerateRandomMin,
      autoGenerateRandomMax,
      autoPreviewPrompt,
      autoSection,
    }
  }

  function updateFloatingWidgetRowVisibility(show: boolean) {
    if (rowWidgetSize) rowWidgetSize.style.display = show ? '' : 'none'
    if (rowWidgetStyle) rowWidgetStyle.style.display = show ? '' : 'none'
  }

  function updateGenerationHistoryRowVisibility(show: boolean) {
    if (rowSwipeToRegenerate) rowSwipeToRegenerate.style.display = show ? '' : 'none'
  }

  function updateShutterImageLayoutVisibility(mode: Settings['shutterImageLayout']) {
    const show = mode !== 'off'
    if (rowShutterImageWidth) rowShutterImageWidth.style.display = show ? '' : 'none'
    if (rowShutterImageAlign) rowShutterImageAlign.style.display = show ? '' : 'none'
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
    handles.generationHistory.destroy()
    handles.swipeToRegenerate.destroy()
    handles.removeImageTagsFromContext.destroy()
    handles.showPromptInLightbox.destroy()
    handles.autoGenerateInterval.destroy()
    handles.autoGenerateRandomMin.destroy()
    handles.autoGenerateRandomMax.destroy()
    handles.autoPreviewPrompt.destroy()
    handles.autoSection.destroy()
    handles = null
    rowWidgetSize = null
    rowWidgetStyle = null
    rowInterval = null
    rowRandom = null
    rowAutoAfter = null
    rowAutoPreview = null
    rowShutterImageWidth = null
    rowShutterImageAlign = null
    selectWidgetSize = null
    selectWidgetStyle = null
    selectIconTheme = null
    selectAfterGenerate = null
    selectAutoGenerate = null
    selectAutoGenerateAfter = null
    selectDefaultAction = null
    selectDeleteConfirmation = null
    selectShutterImageLayout = null
    inputShutterImageWidth = null
    selectShutterImageAlign = null
  }

  function syncSettingsToHandles(s: Settings) {
    if (!handles) return

    // Shared components — use update()
    handles.showFloatWidget.update({ checked: s.showFloatWidget })
    handles.toastOnInsert.update({ checked: s.toastOnInsert })
    handles.autoGenerateInterval.update({ value: s.autoGenerateInterval })
    handles.autoGenerateRandomMin.update({ value: s.autoGenerateRandomMin })
    handles.autoGenerateRandomMax.update({ value: s.autoGenerateRandomMax })
    handles.autoPreviewPrompt.update({ checked: s.autoPreviewPrompt })
    handles.showPromptInLightbox.update({ checked: s.showPromptInLightbox })

    // Native selects / inputs — set .value directly
    if (selectWidgetSize) selectWidgetSize.value = s.widgetSize
    if (selectWidgetStyle) selectWidgetStyle.value = s.widgetStyle
    if (selectIconTheme) selectIconTheme.value = s.iconTheme
    if (selectAfterGenerate) selectAfterGenerate.value = s.afterGenerate
    if (selectAutoGenerate) selectAutoGenerate.value = s.autoGenerate
    if (selectAutoGenerateAfter) selectAutoGenerateAfter.value = s.autoGenerateAfter
    if (selectDefaultAction) selectDefaultAction.value = s.defaultAction
    if (selectDeleteConfirmation) selectDeleteConfirmation.value = s.deleteConfirmation
    if (selectShutterImageLayout) selectShutterImageLayout.value = s.shutterImageLayout
    if (inputShutterImageWidth) inputShutterImageWidth.value = String(clampShutterImageWidth(s.shutterImageWidth))
    if (selectShutterImageAlign) selectShutterImageAlign.value = s.shutterImageAlign

    updateFloatingWidgetRowVisibility(s.showFloatWidget)
    updateShutterImageLayoutVisibility(s.shutterImageLayout)
    updateAutoRowVisibility(s.autoGenerate)
  }


  // Exact logic of the pre-split backend-message branch: first validated
  // settings payload mounts the panel (reentrancy-guarded); later payloads
  // sync the existing handles/controls in place.
  function applyIncoming(s: Settings): void {
    if (!handles) {
      if (settingsMounting) return
      settingsMounting = true
      mountSettings(s)
      settingsMounting = false
    } else {
      syncSettingsToHandles(s)
    }
  }

  return {
    applyIncoming,
    isMounted: () => handles !== null,
    // Used by the entry when permission-sensitive rows must be rebuilt:
    // destroy() then mount(s) — same sequence as pre-split.
    mount: mountSettings,
    destroy: destroySettingsHandles,
  }
}
