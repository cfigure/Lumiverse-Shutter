import type { SpindleFloatWidgetHandle, SpindleFrontendContext } from 'lumiverse-spindle-types'
import { getIconSet } from './icons'
import type { Settings } from './settings'

const WIDGET_SIZES: Record<Settings['widgetSize'], number> = {
  small: 44,
  medium: 56,
  large: 72,
  xlarge: 96,
}

// Keep this aligned with Lumiverse's host-side drag threshold. Using the
// Euclidean distance also matches the host's geometry contract.
const DRAG_THRESHOLD_PX = 4
const LONG_PRESS_MS = 500

export type ShutterFloatWidget = {
  handle: SpindleFloatWidgetHandle
  setGenerating(active: boolean): void
  setVisible(visible: boolean): void
  syncAppearance(settings: Settings): void
  destroy(): void
}

export function mountShutterFloatWidget(options: {
  ctx: SpindleFrontendContext
  settings: Settings
  onGenerate(): void
  onMenu(x: number, y: number): void
  width?: number
  height?: number
  chromeless?: boolean
}): ShutterFloatWidget {
  const { ctx } = options
  let currentSettings = options.settings
  const initialSize = WIDGET_SIZES[currentSettings.widgetSize] || 44
  const handle = ctx.ui.createFloatWidget({
    width: options.width ?? initialSize,
    height: options.height ?? initialSize,
    initialPosition: { x: 60, y: window.innerHeight - 140 },
    snapToEdge: true,
    tooltip: 'Shutter',
    chromeless: options.chromeless ?? true,
  })

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'sh-float-btn'
  btn.setAttribute('aria-label', 'Generate image')

  let pointerStart: { id: number; x: number; y: number } | null = null
  let longPressTimer: ReturnType<typeof setTimeout> | null = null
  let suppressNextClick = false
  let lastLongPressAt = 0

  function renderIcon(): void {
    const icon = getIconSet(currentSettings.iconTheme)
    btn.innerHTML = currentSettings.widgetStyle === 'mono' ? icon.floatingMono : icon.floatingColor
  }

  function cancelLongPress(): void {
    if (longPressTimer) clearTimeout(longPressTimer)
    longPressTimer = null
  }

  function clearPointer(): void {
    cancelLongPress()
    pointerStart = null
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    clearPointer()
    pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY }
    suppressNextClick = false
    longPressTimer = setTimeout(() => {
      if (!pointerStart) return
      suppressNextClick = true
      lastLongPressAt = Date.now()
      longPressTimer = null
      navigator.vibrate?.(50)
      options.onMenu(pointerStart.x, pointerStart.y)
    }, LONG_PRESS_MS)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!pointerStart || event.pointerId !== pointerStart.id) return
    const distance = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y)
    if (distance >= DRAG_THRESHOLD_PX) {
      suppressNextClick = true
      cancelLongPress()
    }
  }

  function onPointerEnd(event: PointerEvent): void {
    if (!pointerStart || event.pointerId !== pointerStart.id) return
    clearPointer()
    // A click caused by this pointer sequence is dispatched synchronously
    // after pointerup. Clear the guard on the next task so it cannot swallow
    // the user's following click when the host suppresses the drag click.
    if (suppressNextClick) setTimeout(() => { suppressNextClick = false }, 0)
  }

  function onWindowBlur(): void {
    clearPointer()
    suppressNextClick = false
  }

  function onClick(event: MouseEvent): void {
    if (suppressNextClick) {
      suppressNextClick = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    options.onGenerate()
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault()
    // Touch long-press can synthesize a contextmenu immediately after the
    // timer fires. Avoid opening the same menu twice.
    if (Date.now() - lastLongPressAt < 750) return
    options.onMenu(event.clientX, event.clientY)
  }

  btn.addEventListener('pointerdown', onPointerDown)
  btn.addEventListener('click', onClick)
  btn.addEventListener('contextmenu', onContextMenu)
  // Listen in capture phase at window level: staging may move pointer capture
  // to the widget host while dragging, so button-level pointerup is not enough.
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerEnd, true)
  window.addEventListener('pointercancel', onPointerEnd, true)
  window.addEventListener('blur', onWindowBlur)

  renderIcon()
  handle.root.appendChild(btn)

  return {
    handle,
    setGenerating(active: boolean) {
      btn.disabled = active
      btn.classList.toggle('sh-generating', active)
    },
    setVisible(visible: boolean) {
      handle.setVisible(visible)
    },
    syncAppearance(settings: Settings) {
      const sizeChanged = settings.widgetSize !== currentSettings.widgetSize
      const iconChanged = settings.widgetStyle !== currentSettings.widgetStyle
        || settings.iconTheme !== currentSettings.iconTheme
      currentSettings = settings
      if (sizeChanged) {
        const size = WIDGET_SIZES[currentSettings.widgetSize] || 44
        handle.setSize(size, size)
      }
      if (iconChanged) renderIcon()
    },
    destroy() {
      clearPointer()
      btn.removeEventListener('pointerdown', onPointerDown)
      btn.removeEventListener('click', onClick)
      btn.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerup', onPointerEnd, true)
      window.removeEventListener('pointercancel', onPointerEnd, true)
      window.removeEventListener('blur', onWindowBlur)
      handle.destroy()
    },
  }
}
