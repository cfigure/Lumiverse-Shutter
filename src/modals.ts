// Shutter's modal surfaces: the post-generation destination modal, the
// error modal, the mini image lightbox used by the destination preview, the
// View Prompt modal, and the Preview & Edit prompt modal. Moved whole from
// frontend.ts. Generation-flow functions stay in the entry (they call these
// modals and are called BY them — the cycle is broken by routing the
// generation side through the deps object).

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { Settings } from './settings'
import type { Comms } from './comms'
import type { GenerationResult, GenerationSkipped } from './frontend'
import { resolveEmbeddedPromptForImage } from './metadata'
import { COPY_CHECK_SVG } from './styles'
import {
  formatPromptMetadataForClipboard,
  formatPromptMetadataLine,
  imageUrlForHistoryRecord,
  promptViewFromEmbedded,
  promptViewFromRecord,
  type GenerationHistoryRecord,
  type GenerationOrigin,
  type GenerationTarget,
  type PromptMetadataView,
} from './history'

export function createModals(deps: {
  ctx: SpindleFrontendContext
  comms: Comms
  getSettings: () => Settings | null
  triggerGenerate: (messageId?: string, chatId?: string, isAuto?: boolean, replace?: boolean, force?: boolean, pinnedTarget?: GenerationTarget, origin?: GenerationOrigin) => void
  handleGenerationResult: (result: GenerationResult, target: GenerationTarget, isAuto: boolean, replace?: boolean, origin?: GenerationOrigin) => Promise<void>
  setGeneratingState: (active: boolean) => void
  callImageGen: (chatId: string, overrides?: Record<string, any>, target?: GenerationTarget) => Promise<GenerationResult | GenerationSkipped>
  callPreviewPrompt: (chatId: string) => Promise<{ prompt: string; negativePrompt: string }>
  notifyGenerationSkipped: (reason: string) => void
  parseErrorMessage: (raw: string) => string
}) {
  const { ctx, comms } = deps

  let promptPreviewOpen = false

  type GeneratedImageAvailability = 'available' | 'missing' | 'unknown'
  type GeneratedImageAvailabilityCacheEntry = {
    status: Exclude<GeneratedImageAvailability, 'unknown'>
    checkedAt: number
  }

  const IMAGE_AVAILABILITY_MAX_AGE_MS = 10_000
  const imageAvailabilityCache = new Map<string, GeneratedImageAvailabilityCacheEntry>()
  const imageAvailabilityPending = new Map<string, Promise<GeneratedImageAvailability>>()

  function getCachedImageAvailability(imageId: string, maxAgeMs = IMAGE_AVAILABILITY_MAX_AGE_MS): GeneratedImageAvailability | null {
    const cached = imageAvailabilityCache.get(imageId)
    if (!cached) return null
    if (cached.status === 'missing') return 'missing'
    if (Date.now() - cached.checkedAt <= maxAgeMs) return cached.status
    imageAvailabilityCache.delete(imageId)
    return null
  }

  async function checkGeneratedImageAvailability(
    imageId: string,
    options: { maxAgeMs?: number; force?: boolean } = {},
  ): Promise<GeneratedImageAvailability> {
    if (!options.force) {
      const cached = getCachedImageAvailability(imageId, options.maxAgeMs)
      if (cached) return cached
      const pending = imageAvailabilityPending.get(imageId)
      if (pending) return pending
    }

    const request = (async (): Promise<GeneratedImageAvailability> => {
      try {
        const probeId = typeof crypto?.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const response = await fetch(
          `/api/v1/image-gen/results/${encodeURIComponent(imageId)}?shutter_probe=${encodeURIComponent(probeId)}`,
          {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Range: 'bytes=0-0' },
          },
        )

        const status: GeneratedImageAvailability = response.status === 404
          ? 'missing'
          : response.ok
            ? 'available'
            : 'unknown'
        try { await response.body?.cancel() } catch { /* best-effort early body release */ }

        if (status !== 'unknown') {
          imageAvailabilityCache.set(imageId, { status, checkedAt: Date.now() })
        }
        return status
      } catch {
        return 'unknown'
      } finally {
        imageAvailabilityPending.delete(imageId)
      }
    })()

    imageAvailabilityPending.set(imageId, request)
    return request
  }

  function makeUnavailablePreview(): {
    root: HTMLDivElement
    title: HTMLDivElement
    detail: HTMLDivElement
  } {
    const root = document.createElement('div')
    root.className = 'sh-image-unavailable'
    root.hidden = true
    root.setAttribute('role', 'status')

    const icon = document.createElement('div')
    icon.className = 'sh-image-unavailable-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/><path d="M4 4l16 16"/></svg>'

    const title = document.createElement('div')
    title.className = 'sh-image-unavailable-title'
    const detail = document.createElement('div')
    detail.className = 'sh-image-unavailable-detail'

    root.append(icon, title, detail)
    return { root, title, detail }
  }

  function setUnavailablePreview(
    placeholder: ReturnType<typeof makeUnavailablePreview>,
    state: 'missing' | 'unknown' | 'checking',
  ): void {
    placeholder.root.dataset.state = state
    if (state === 'missing') {
      placeholder.title.textContent = 'Image unavailable'
      placeholder.detail.textContent = 'The original image file has been deleted. Its saved Shutter prompt is still available.'
    } else if (state === 'checking') {
      placeholder.title.textContent = 'Checking image availability…'
      placeholder.detail.textContent = 'The saved Shutter prompt remains available.'
    } else {
      placeholder.title.textContent = 'Image availability could not be checked'
      placeholder.detail.textContent = 'The saved Shutter prompt remains available. Try again when the connection is available.'
    }
  }

  function showAvailabilityToast(status: Exclude<GeneratedImageAvailability, 'available'>): void {
    ctx.sendToBackend({
      type: 'show_toast',
      level: status === 'missing' ? 'info' : 'warning',
      message: status === 'missing'
        ? 'The original image has been deleted. Its saved Shutter prompt is still available.'
        : 'Shutter could not verify that this image is still available.',
    })
  }

  type ModalHandle = {
    root: HTMLElement
    dismiss(): void
    setTitle(title: string): void
    onDismiss(callback: () => void): (() => void) | void
  }

  const modalInputStack: symbol[] = []

  // ── Modals ──

  // ── Lightbox state (for cleanup) ──

  let activeLightbox: { overlay: HTMLElement; keyHandler: (e: KeyboardEvent) => void } | null = null

  function dismissLightbox() {
    if (!activeLightbox) return
    window.removeEventListener('keydown', activeLightbox.keyHandler, { capture: true })
    activeLightbox.overlay.remove()
    activeLightbox = null
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    const el = target instanceof HTMLElement ? target : document.activeElement as HTMLElement | null
    return !!el && (
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable
    )
  }

  // Spindle modals are visually foregrounded, but Lumiverse's global chat
  // navigation does not treat them as native active modals. Arrow keys must
  // be isolated at window capture: when no modal control is focused, the key
  // event targets the page and never passes through modal.root. Touch events
  // originate inside the modal, so root-level propagation blocking remains
  // appropriate. Editable controls keep their native caret behaviour because
  // their arrow-key default is not prevented.
  function isolateModalInput(
    modal: ModalHandle,
    options: { blockArrows?: boolean; onEscape?: () => void } = {},
  ) {
    const blockArrows = options.blockArrows !== false
    const stackToken = Symbol('shutter-modal-input')
    modalInputStack.push(stackToken)

    const isTopModal = () => modalInputStack[modalInputStack.length - 1] === stackToken
    const keyBlocker = (e: KeyboardEvent) => {
      if (!isTopModal()) return

      if (e.key === 'Escape') {
        // The preview lightbox is the foreground surface and owns Escape.
        if (activeLightbox) return
        e.preventDefault()
        e.stopImmediatePropagation()
        if (options.onEscape) options.onEscape()
        else modal.dismiss()
        return
      }

      if (!blockArrows || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (!isEditableTarget(e.target)) e.preventDefault()
      // Capture at window so Lumiverse's document-level chat navigation never
      // sees the key. Not preventing default for editable targets preserves
      // normal caret/selection movement.
      e.stopImmediatePropagation()
    }
    const touchBlocker = (e: TouchEvent) => {
      e.stopPropagation()
    }

    modal.root.addEventListener('touchstart', touchBlocker)
    modal.root.addEventListener('touchmove', touchBlocker)
    modal.root.addEventListener('touchend', touchBlocker)
    modal.root.addEventListener('touchcancel', touchBlocker)
    window.addEventListener('keydown', keyBlocker, { capture: true })

    modal.onDismiss(() => {
      modal.root.removeEventListener('touchstart', touchBlocker)
      modal.root.removeEventListener('touchmove', touchBlocker)
      modal.root.removeEventListener('touchend', touchBlocker)
      modal.root.removeEventListener('touchcancel', touchBlocker)
      window.removeEventListener('keydown', keyBlocker, { capture: true })
      const stackIndex = modalInputStack.lastIndexOf(stackToken)
      if (stackIndex >= 0) modalInputStack.splice(stackIndex, 1)
    })
  }

  function setImagePromptOverflow(modal: ModalHandle, enabled: boolean): void {
    const hostBody = modal.root.parentElement
    if (hostBody instanceof HTMLElement) hostBody.style.overflowY = enabled ? 'hidden' : 'auto'
    modal.root.classList.toggle('sh-image-prompt-root', enabled)
  }

  function makeReadonlyPromptField(label: string, text: string, kind: 'positive' | 'negative'): HTMLElement {
    const field = document.createElement('div')
    field.className = `sh-prompt-field sh-image-prompt-field sh-image-prompt-field-${kind}`
    const heading = document.createElement('div')
    heading.className = 'sh-prompt-label'
    heading.textContent = label
    const block = document.createElement('div')
    block.className = 'sh-prompt-readonly sh-image-prompt-readonly'
    block.textContent = text
    field.append(heading, block)
    return field
  }

  function setCopyFeedback(button: HTMLButtonElement, view: PromptMetadataView): void {
    navigator.clipboard.writeText(formatPromptMetadataForClipboard(view)).then(() => {
      button.innerHTML = `${COPY_CHECK_SVG} Copied`
      button.classList.add('sh-copied')
      setTimeout(() => {
        if (!button.isConnected) return
        button.textContent = 'Copy Prompt'
        button.classList.remove('sh-copied')
      }, 2000)
    }).catch(() => {
      button.textContent = 'Failed'
      setTimeout(() => { if (button.isConnected) button.textContent = 'Copy Prompt' }, 1200)
    })
  }

  function renderImagePromptSurface(
    modal: ModalHandle,
    options: {
      initialView: PromptMetadataView
      shutterView?: PromptMetadataView | null
      embeddedView?: PromptMetadataView | null
      onClose: () => void
      dismissLabel?: 'Close' | 'Back'
      historyLabel?: string
      onViewHistory?: () => void
      onUsePrompt?: (view: PromptMetadataView) => void
    },
  ): void {
    modal.setTitle('Image Prompt')
    setImagePromptOverflow(modal, true)

    let activeView = options.initialView
    const body = document.createElement('div')
    body.className = 'sh-prompt-body sh-image-prompt-body'

    const sourceSlot = document.createElement('div')
    let usePromptBtn: HTMLButtonElement | null = null
    const meta = document.createElement('div')
    meta.className = 'sh-prompt-source-meta sh-image-prompt-meta'
    const fields = document.createElement('div')
    fields.className = 'sh-prompt-source-fields sh-image-prompt-fields'

    const renderView = (view: PromptMetadataView) => {
      activeView = view
      sourceSlot.querySelectorAll<HTMLButtonElement>('.sh-prompt-source-btn').forEach(button => {
        const selected = button.dataset.source === view.source
        button.classList.toggle('sh-active', selected)
        button.setAttribute('aria-selected', String(selected))
      })

      const metadataLine = formatPromptMetadataLine(view)
      meta.textContent = metadataLine
      meta.hidden = !metadataLine
      if (usePromptBtn) usePromptBtn.disabled = !view.prompt.trim()

      fields.replaceChildren()
      fields.classList.toggle('sh-no-negative', !view.negativePrompt)
      fields.appendChild(makeReadonlyPromptField('Positive Prompt', view.prompt || 'Prompt unavailable', 'positive'))
      if (view.negativePrompt) {
        fields.appendChild(makeReadonlyPromptField('Negative Prompt', view.negativePrompt, 'negative'))
      }
    }

    const shutterView = options.shutterView ?? null
    const embeddedView = options.embeddedView ?? null
    if (shutterView && embeddedView) {
      sourceSlot.className = 'sh-prompt-source-tabs'
      sourceSlot.setAttribute('role', 'tablist')
      sourceSlot.setAttribute('aria-label', 'Prompt metadata source')
      for (const [source, label, view] of [
        ['shutter', 'Shutter', shutterView],
        ['embedded', 'Embedded', embeddedView],
      ] as const) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'sh-prompt-source-btn'
        button.dataset.source = source
        button.textContent = label
        button.setAttribute('role', 'tab')
        button.addEventListener('click', () => renderView(view))
        sourceSlot.appendChild(button)
      }
      body.appendChild(sourceSlot)
    }

    body.append(meta, fields)

    const actions = document.createElement('div')
    actions.className = 'sh-prompt-actions sh-image-prompt-actions'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'sh-prompt-btn sh-prompt-btn-cancel'
    closeBtn.textContent = options.dismissLabel ?? 'Close'
    closeBtn.addEventListener('click', options.onClose)
    actions.appendChild(closeBtn)

    if (options.onViewHistory && options.historyLabel) {
      const historyBtn = document.createElement('button')
      historyBtn.type = 'button'
      historyBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary'
      historyBtn.textContent = options.historyLabel
      historyBtn.title = 'View generation history for this message response'
      historyBtn.addEventListener('click', options.onViewHistory)
      actions.appendChild(historyBtn)
    }

    const copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary'
    copyBtn.textContent = 'Copy Prompt'
    copyBtn.addEventListener('click', () => setCopyFeedback(copyBtn, activeView))
    actions.appendChild(copyBtn)

    if (options.onUsePrompt) {
      usePromptBtn = document.createElement('button')
      usePromptBtn.type = 'button'
      usePromptBtn.className = 'sh-prompt-btn sh-prompt-btn-primary'
      usePromptBtn.textContent = 'Use Prompt'
      usePromptBtn.title = 'Open this prompt in Preview & Edit Image Prompt'
      usePromptBtn.addEventListener('click', () => {
        if (!activeView.prompt.trim()) return
        options.onUsePrompt?.(activeView)
      })
      actions.appendChild(usePromptBtn)
    }

    body.appendChild(actions)

    modal.root.replaceChildren(body)
    renderView(activeView)
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

    // The preview lightbox is intentionally a static viewer. Consume arrows
    // so neither the Generate Image modal nor the background chat can react.
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        dismissLightbox()
        return
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', keyHandler, { capture: true })

    // Keep touch gestures inside the lightbox. There is deliberately no
    // swipe navigation here; history remains owned by the underlying modal.
    const stopTouch = (e: TouchEvent) => e.stopPropagation()
    overlay.addEventListener('touchstart', stopTouch)
    overlay.addEventListener('touchmove', stopTouch)
    overlay.addEventListener('touchend', stopTouch)
    overlay.addEventListener('touchcancel', stopTouch)

    activeLightbox = { overlay, keyHandler }
    document.body.appendChild(overlay)
  }

  function makeDestBtn(label: string, tooltip: string, variant: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = `sh-prompt-btn ${variant}`
    btn.textContent = label
    btn.title = tooltip
    btn.addEventListener('click', onClick)
    return btn
  }

  // ── Durable generation history (1.1.0) ──
  //
  // The backend/userStorage record is authoritative. The modal receives the
  // complete history for the pinned message swipe, so a fresh widget press,
  // Rebuild Prompt, a browser restart, or another device all reopen the same
  // sequence. The generated image itself is not duplicated in userStorage.

  let activeDestinationModal: { dismiss(): void } | null = null

  function openDestinationModal(
    result: GenerationResult,
    target: GenerationTarget,
    isAuto: boolean,
    replace = false,
    storedHistory: GenerationHistoryRecord[] = [],
  ) {
    const settings = deps.getSettings()
    const historyEnabled = settings?.generationHistory === true
    const gestureEnabled = historyEnabled && settings?.gestureNavigation === true

    const fallbackRecord: GenerationHistoryRecord = {
      version: 1,
      imageId: result.imageId,
      createdAt: Date.now(),
      prompt: result.prompt,
      negativePrompt: result.negativePrompt,
      promptMode: result.promptMode,
      origin: isAuto ? 'auto' : 'manual',
      provider: result.provider,
      model: result.model,
      target,
    }

    const history = historyEnabled ? [...storedHistory] : [fallbackRecord]
    if (!history.some(entry => entry.imageId === result.imageId)) history.push(fallbackRecord)
    history.sort((a, b) => a.createdAt - b.createdAt || a.imageId.localeCompare(b.imageId))

    let idx = Math.max(0, history.findIndex(entry => entry.imageId === result.imageId))
    if (idx < 0) idx = history.length - 1
    const current = () => history[idx]!

    activeDestinationModal?.dismiss()
    const modal = ctx.ui.showModal({ title: 'Image Generated', width: 640, persistent: true })
    activeDestinationModal = modal
    isolateModalInput(modal, { blockArrows: !gestureEnabled })
    const container = document.createElement('div')
    container.className = 'sh-modal-body'

    imageAvailabilityCache.set(result.imageId, { status: 'available', checkedAt: Date.now() })
    let selectedAvailability: GeneratedImageAvailability | 'checking' = 'checking'
    let previewLoadFailed = false
    let availabilityRenderToken = 0
    let insertBtn: HTMLButtonElement | null = null

    const previewWrap = document.createElement('div')
    previewWrap.className = 'sh-preview'
    const preview = document.createElement('img')
    preview.alt = 'Selected Shutter generation'
    const unavailablePreview = makeUnavailablePreview()
    preview.addEventListener('click', () => {
      if (selectedAvailability !== 'missing' && !(selectedAvailability === 'unknown' && previewLoadFailed)) {
        openLightbox(imageUrlForHistoryRecord(current()))
      }
    })
    preview.addEventListener('load', () => {
      previewLoadFailed = false
      if (selectedAvailability !== 'missing') unavailablePreview.root.hidden = true
    })
    preview.addEventListener('error', () => {
      previewLoadFailed = true
      if (selectedAvailability === 'missing') setUnavailablePreview(unavailablePreview, 'missing')
      else if (selectedAvailability === 'unknown') setUnavailablePreview(unavailablePreview, 'unknown')
      else setUnavailablePreview(unavailablePreview, 'checking')
      preview.hidden = true
      unavailablePreview.root.hidden = false
      if (insertBtn) insertBtn.disabled = true
    })
    previewWrap.append(preview, unavailablePreview.root)

    const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>'
    const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'
    const makeNavBtn = (dir: -1 | 1): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'sh-hist-btn'
      btn.innerHTML = dir === -1 ? CHEVRON_LEFT : CHEVRON_RIGHT
      btn.title = dir === -1 ? 'Previous generation' : 'Next generation'
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        stepHistory(dir)
      })
      return btn
    }
    const navPrev = makeNavBtn(-1)
    const navNext = makeNavBtn(1)
    const histCount = document.createElement('span')
    histCount.className = 'sh-hist-counter'
    const histPill = document.createElement('div')
    histPill.className = 'sh-hist-pill'
    histPill.addEventListener('click', event => event.stopPropagation())
    histPill.appendChild(navPrev)
    histPill.appendChild(histCount)
    histPill.appendChild(navNext)
    if (historyEnabled) previewWrap.appendChild(histPill)
    container.appendChild(previewWrap)

    function applyDestinationAvailability(status: GeneratedImageAvailability): void {
      selectedAvailability = status
      const unavailable = status === 'missing' || (status === 'unknown' && previewLoadFailed)
      preview.hidden = unavailable
      unavailablePreview.root.hidden = !unavailable
      previewWrap.classList.toggle('sh-preview-unavailable', unavailable)
      if (unavailable) setUnavailablePreview(unavailablePreview, status === 'missing' ? 'missing' : 'unknown')
      if (insertBtn) {
        insertBtn.disabled = unavailable
        insertBtn.title = status === 'missing'
          ? 'The original image file has been deleted'
          : status === 'unknown' && previewLoadFailed
            ? 'Shutter could not verify that this image is available'
            : 'Insert the selected image into its message response'
      }
      if (status === 'missing') dismissLightbox()
    }

    function refreshDestinationAvailability(entry: GenerationHistoryRecord): void {
      const token = ++availabilityRenderToken
      previewLoadFailed = false
      selectedAvailability = 'checking'
      preview.hidden = false
      unavailablePreview.root.hidden = true
      previewWrap.classList.remove('sh-preview-unavailable')
      if (insertBtn) insertBtn.disabled = false

      const cached = getCachedImageAvailability(entry.imageId)
      if (cached) {
        applyDestinationAvailability(cached)
        return
      }

      void checkGeneratedImageAvailability(entry.imageId).then(status => {
        if (token !== availabilityRenderToken || current().imageId !== entry.imageId || !modal.root.isConnected) return
        applyDestinationAvailability(status)
      })
    }

    function renderHistory() {
      const entry = current()
      const url = imageUrlForHistoryRecord(entry)
      refreshDestinationAvailability(entry)
      preview.src = url
      if (activeLightbox && selectedAvailability !== 'missing') {
        const img = activeLightbox.overlay.querySelector('img')
        if (img) img.src = url
      }
      navPrev.disabled = idx === 0
      const atEnd = idx === history.length - 1
      navNext.disabled = atEnd && !entry.prompt.trim()
      navNext.title = atEnd ? 'Regenerate image (same prompt)' : 'Next generation'
      histCount.textContent = `${idx + 1} / ${history.length}`
    }

    let regenerating = false
    async function regenerateFromSelected() {
      if (regenerating) return
      const selected = current()
      const resolvedPrompt = selected.prompt.trim()
      if (!resolvedPrompt) {
        modal.dismiss()
        showErrorModal('Cannot regenerate because the submitted prompt was not saved.')
        return
      }

      regenerating = true
      modal.dismiss()
      deps.setGeneratingState(true)
      try {
        const next = await deps.callImageGen(target.chatId, {
          prompt: resolvedPrompt,
          negativePrompt: selected.negativePrompt,
          skipParse: true,
        }, target)
        if ('skipped' in next) {
          deps.setGeneratingState(false)
          deps.notifyGenerationSkipped(next.reason)
          return
        }
        await deps.handleGenerationResult(next, target, isAuto, replaceChecked, 'regenerate')
      } catch (err: any) {
        deps.setGeneratingState(false)
        showErrorModal(deps.parseErrorMessage(err.message))
      }
    }

    function stepHistory(dir: -1 | 1) {
      const next = idx + dir
      if (next >= history.length) {
        void regenerateFromSelected()
        return
      }
      if (next < 0) return
      idx = next
      renderHistory()
    }

    const arrowHandler = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (activeLightbox) return
      const active = document.activeElement as HTMLElement | null
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
      event.preventDefault()
      event.stopPropagation()
      stepHistory(event.key === 'ArrowLeft' ? -1 : 1)
    }
    if (gestureEnabled) window.addEventListener('keydown', arrowHandler, { capture: true })

    let touchStartX = 0, touchStartY = 0, touchStartT = 0
    let touchLock: 'h' | 'v' | null = null
    if (gestureEnabled) {
      previewWrap.addEventListener('touchstart', (event) => {
        if (event.touches.length !== 1) { touchLock = 'v'; return }
        const touch = event.touches[0]!
        touchStartX = touch.clientX
        touchStartY = touch.clientY
        touchStartT = Date.now()
        touchLock = null
      }, { passive: true })
      previewWrap.addEventListener('touchmove', (event) => {
        if (touchLock) { if (touchLock === 'h') event.preventDefault(); return }
        const touch = event.touches[0]!
        const dx = touch.clientX - touchStartX
        const dy = touch.clientY - touchStartY
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
        touchLock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
        if (touchLock === 'h') event.preventDefault()
      }, { passive: false })
      previewWrap.addEventListener('touchend', (event) => {
        if (touchLock !== 'h') return
        const touch = event.changedTouches[0]!
        const dx = touch.clientX - touchStartX
        const dt = Math.max(Date.now() - touchStartT, 1)
        if (Math.abs(dx) >= 50 || Math.abs(dx) / dt >= 0.3) stepHistory(dx < 0 ? 1 : -1)
      }, { passive: true })
    }

    let replaceChecked = replace || (deps.getSettings()?.defaultAction === 'replace')
    const replaceSlot = document.createElement('div')
    replaceSlot.className = 'sh-replace-row'
    const replaceCheckbox = ctx.components.mountCheckbox(replaceSlot, {
      checked: replaceChecked,
      label: 'Replace existing image',
      onChange: (on: boolean) => { replaceChecked = on },
    })
    container.appendChild(replaceSlot)

    const choices = document.createElement('div')
    choices.className = 'sh-prompt-actions'
    choices.appendChild(makeDestBtn('Close', 'Close without inserting', 'sh-prompt-btn-cancel', () => modal.dismiss()))
    choices.appendChild(makeDestBtn('Rebuild Prompt', 'Re-parse the chat and generate a new prompt', 'sh-prompt-btn-secondary', () => {
      modal.dismiss()
      deps.triggerGenerate(target.messageId, target.chatId, isAuto, replaceChecked, false, target, 'rebuild')
    }))
    choices.appendChild(makeDestBtn('Regenerate Image', 'Generate again with the selected image’s prompt', 'sh-prompt-btn-secondary', () => {
      void regenerateFromSelected()
    }))
    const commitDestinationInsert = (): void => {
      ctx.sendToBackend({
        type: 'insert_into_message',
        imageId: current().imageId,
        messageId: target.messageId,
        chatId: target.chatId,
        target,
        replace: replaceChecked,
      })
      modal.dismiss()
    }
    const destinationInsertBtn = makeDestBtn('Insert', 'Insert the selected image into its message response', 'sh-prompt-btn-primary', () => {
      const entry = current()
      const cached = getCachedImageAvailability(entry.imageId, 1_500)
      if (cached === 'available') {
        commitDestinationInsert()
        return
      }
      if (cached === 'missing') {
        applyDestinationAvailability('missing')
        showAvailabilityToast('missing')
        return
      }

      destinationInsertBtn.disabled = true
      void checkGeneratedImageAvailability(entry.imageId, { maxAgeMs: 1_500 }).then(status => {
        if (!modal.root.isConnected || current().imageId !== entry.imageId) return
        applyDestinationAvailability(status)
        if (status === 'available') commitDestinationInsert()
        else showAvailabilityToast(status)
      })
    })
    insertBtn = destinationInsertBtn
    choices.appendChild(destinationInsertBtn)
    container.appendChild(choices)
    modal.root.appendChild(container)

    renderHistory()

    modal.onDismiss(() => {
      if (activeDestinationModal === modal) activeDestinationModal = null
      dismissLightbox()
      window.removeEventListener('keydown', arrowHandler, { capture: true })
      replaceCheckbox.destroy()
    })
  }

  let activeHistoryViewerModal: ModalHandle | null = null

  function openHistoryViewer(
    records: GenerationHistoryRecord[],
    initialImageId: string,
    options: {
      closeUnderlyingLightbox?: () => void
      closeParentPrompt?: () => void
      dismissLabel?: 'Back' | 'Close'
      replaceImageId?: string | null
    } = {},
  ): void {
    const {
      closeUnderlyingLightbox,
      closeParentPrompt,
      dismissLabel = 'Back',
    } = options
    const replaceImageId = options.replaceImageId === null
      ? undefined
      : options.replaceImageId ?? initialImageId
    const history = [...records].sort((a, b) => a.createdAt - b.createdAt || a.imageId.localeCompare(b.imageId))
    if (history.length === 0) return

    activeHistoryViewerModal?.dismiss()
    let idx = history.findIndex(entry => entry.imageId === initialImageId)
    if (idx < 0) idx = history.length - 1
    const current = () => history[idx]!

    // Match the Image Generated modal's shell, width, preview sizing, and
    // footer placement. The same modal body is reused for View Prompt so the
    // logical Widget Prompt -> History -> Prompt flow stays within Lumiverse's
    // two-modal extension limit.
    const modal = ctx.ui.showModal({ title: 'Generation History', width: 640, persistent: true }) as ModalHandle
    activeHistoryViewerModal = modal
    let surface: 'history' | 'prompt' = 'history'
    let committing = false
    let promptRenderToken = 0
    let selectedAvailability: GeneratedImageAvailability | 'checking' = 'checking'
    let previewLoadFailed = false
    let availabilityRenderToken = 0

    const closeCurrentSurface = () => {
      if (committing) return
      if (surface === 'prompt') renderHistorySurface()
      else modal.dismiss()
    }
    isolateModalInput(modal, { blockArrows: false, onEscape: closeCurrentSurface })

    const container = document.createElement('div')
    container.className = 'sh-modal-body sh-history-body'
    const previewWrap = document.createElement('div')
    previewWrap.className = 'sh-preview'
    const preview = document.createElement('img')
    preview.alt = 'Selected Shutter generation'
    const unavailablePreview = makeUnavailablePreview()
    preview.addEventListener('click', () => {
      if (selectedAvailability !== 'missing' && !(selectedAvailability === 'unknown' && previewLoadFailed)) {
        openLightbox(imageUrlForHistoryRecord(current()))
      }
    })
    preview.addEventListener('load', () => {
      previewLoadFailed = false
      if (selectedAvailability !== 'missing') unavailablePreview.root.hidden = true
    })
    preview.addEventListener('error', () => {
      previewLoadFailed = true
      if (selectedAvailability === 'missing') setUnavailablePreview(unavailablePreview, 'missing')
      else if (selectedAvailability === 'unknown') setUnavailablePreview(unavailablePreview, 'unknown')
      else setUnavailablePreview(unavailablePreview, 'checking')
      preview.hidden = true
      unavailablePreview.root.hidden = false
      updateHistoryActionState()
    })
    previewWrap.append(preview, unavailablePreview.root)

    const nav = document.createElement('div')
    nav.className = 'sh-hist-pill'
    nav.addEventListener('click', event => event.stopPropagation())
    const prev = document.createElement('button')
    const next = document.createElement('button')
    prev.type = next.type = 'button'
    prev.className = next.className = 'sh-hist-btn'
    prev.title = 'Previous generation'
    next.title = 'Next generation'
    prev.setAttribute('aria-label', 'Previous generation')
    next.setAttribute('aria-label', 'Next generation')
    prev.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>'
    next.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'
    const count = document.createElement('span')
    count.className = 'sh-hist-counter'
    nav.append(prev, count, next)
    previewWrap.appendChild(nav)
    container.appendChild(previewWrap)

    const summary = document.createElement('div')
    summary.className = 'sh-generation-meta'
    container.appendChild(summary)

    const actions = document.createElement('div')
    actions.className = 'sh-prompt-actions sh-history-actions'

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'sh-prompt-btn sh-prompt-btn-cancel'
    closeBtn.textContent = dismissLabel
    closeBtn.title = dismissLabel === 'Back'
      ? 'Return to the previous viewer'
      : 'Close Generation History'
    closeBtn.addEventListener('click', () => modal.dismiss())

    const viewPromptBtn = document.createElement('button')
    viewPromptBtn.type = 'button'
    viewPromptBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary'
    viewPromptBtn.textContent = 'View Prompt'
    viewPromptBtn.title = 'View and copy the prompt saved for this generation'

    const openSelectedPrompt = (): void => {
      if (committing) return
      const entry = current()
      const shutterView = promptViewFromRecord(entry)
      const token = ++promptRenderToken
      surface = 'prompt'
      const useSelectedPrompt = (view: PromptMetadataView): void => {
        if (!view.prompt.trim()) return
        modal.dismiss()
        closeParentPrompt?.()
        closeUnderlyingLightbox?.()
        openPromptPreviewModal(view.prompt, view.negativePrompt, entry.target, false, false, 'preview')
      }
      renderImagePromptSurface(modal, {
        initialView: shutterView,
        onClose: renderHistorySurface,
        dismissLabel: 'Back',
        onUsePrompt: useSelectedPrompt,
      })

      // The durable Shutter prompt remains usable after the image asset is
      // deleted, but embedded metadata requires the original image bytes.
      if (selectedAvailability === 'missing' || getCachedImageAvailability(entry.imageId) === 'missing') return

      const imageUrl = imageUrlForHistoryRecord(entry)
      void resolveEmbeddedPromptForImage({ imageId: entry.imageId, path: imageUrl }, imageUrl).then(embedded => {
        if (!embedded || surface !== 'prompt' || token !== promptRenderToken || !modal.root.isConnected) return
        const embeddedView = promptViewFromEmbedded(embedded.prompt, embedded.negativePrompt)
        renderImagePromptSurface(modal, {
          initialView: shutterView,
          shutterView,
          embeddedView,
          onClose: renderHistorySurface,
          dismissLabel: 'Back',
          onUsePrompt: useSelectedPrompt,
        })
      })
    }
    viewPromptBtn.addEventListener('click', openSelectedPrompt)

    const replaceBtn = document.createElement('button')
    replaceBtn.type = 'button'
    replaceBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary'
    replaceBtn.textContent = 'Replace'
    const replaceReadyTitle = replaceImageId
      ? 'Replace the image that opened Generation History'
      : 'Replace the last Shutter image in its original message response'
    replaceBtn.title = replaceReadyTitle

    const insertBtn = document.createElement('button')
    insertBtn.type = 'button'
    insertBtn.className = 'sh-prompt-btn sh-prompt-btn-primary'
    insertBtn.textContent = 'Insert'
    insertBtn.title = 'Insert this image into its original message response'

    function isSelectedImageUnavailable(): boolean {
      return selectedAvailability === 'missing' || (selectedAvailability === 'unknown' && previewLoadFailed)
    }

    function updateHistoryActionState(): void {
      const unavailable = isSelectedImageUnavailable()
      closeBtn.disabled = committing
      viewPromptBtn.disabled = committing
      prev.disabled = committing || idx === 0
      next.disabled = committing || idx === history.length - 1
      replaceBtn.disabled = committing || unavailable
      insertBtn.disabled = committing || unavailable
      replaceBtn.title = selectedAvailability === 'missing'
        ? 'The original image file has been deleted'
        : selectedAvailability === 'unknown' && previewLoadFailed
          ? 'Shutter could not verify that this image is available'
          : replaceReadyTitle
      insertBtn.title = selectedAvailability === 'missing'
        ? 'The original image file has been deleted'
        : selectedAvailability === 'unknown' && previewLoadFailed
          ? 'Shutter could not verify that this image is available'
          : 'Insert this image into its original message response'
    }

    const setCommitDisabled = (disabled: boolean): void => {
      committing = disabled
      updateHistoryActionState()
    }

    const commitSelected = async (replace: boolean): Promise<void> => {
      if (committing) return
      setCommitDisabled(true)
      const entry = current()
      const availability = await checkGeneratedImageAvailability(entry.imageId, { maxAgeMs: 1_500 })
      if (availability !== 'available') {
        if (modal.root.isConnected) {
          selectedAvailability = availability
          if (availability === 'missing' || previewLoadFailed) {
            preview.hidden = true
            unavailablePreview.root.hidden = false
            previewWrap.classList.add('sh-preview-unavailable')
            setUnavailablePreview(unavailablePreview, availability === 'missing' ? 'missing' : 'unknown')
          }
          setCommitDisabled(false)
        }
        showAvailabilityToast(availability)
        return
      }
      const result = await comms.insertIntoMessage({
        imageId: entry.imageId,
        messageId: entry.target.messageId,
        chatId: entry.target.chatId,
        target: entry.target,
        replace,
        // Image-based entry points replace the exact tag that opened History.
        // The direct widget entry leaves this unset, preserving the backend's
        // existing rule of replacing the last Shutter image in the response.
        replaceImageId: replace ? replaceImageId : undefined,
      })
      if (!result.success || !result.changed) {
        if (modal.root.isConnected) {
          setCommitDisabled(false)
          render()
        }
        return
      }

      if (modal.root.isConnected) modal.dismiss()
      closeParentPrompt?.()
      closeUnderlyingLightbox?.()
    }
    replaceBtn.addEventListener('click', () => { void commitSelected(true) })
    insertBtn.addEventListener('click', () => { void commitSelected(false) })

    actions.append(closeBtn, viewPromptBtn, replaceBtn, insertBtn)
    container.appendChild(actions)

    function applyHistoryAvailability(status: GeneratedImageAvailability): void {
      selectedAvailability = status
      const unavailable = status === 'missing' || (status === 'unknown' && previewLoadFailed)
      preview.hidden = unavailable
      unavailablePreview.root.hidden = !unavailable
      previewWrap.classList.toggle('sh-preview-unavailable', unavailable)
      if (unavailable) setUnavailablePreview(unavailablePreview, status === 'missing' ? 'missing' : 'unknown')
      updateHistoryActionState()
      if (status === 'missing') dismissLightbox()
    }

    function refreshHistoryAvailability(entry: GenerationHistoryRecord): void {
      const token = ++availabilityRenderToken
      previewLoadFailed = false
      selectedAvailability = 'checking'
      preview.hidden = false
      unavailablePreview.root.hidden = true
      previewWrap.classList.remove('sh-preview-unavailable')
      updateHistoryActionState()

      const cached = getCachedImageAvailability(entry.imageId)
      if (cached) {
        applyHistoryAvailability(cached)
        return
      }

      void checkGeneratedImageAvailability(entry.imageId).then(status => {
        if (token !== availabilityRenderToken || current().imageId !== entry.imageId || !modal.root.isConnected) return
        applyHistoryAvailability(status)
      })
    }

    function render(): void {
      const entry = current()
      const url = imageUrlForHistoryRecord(entry)
      refreshHistoryAvailability(entry)
      preview.src = url
      count.textContent = `${idx + 1} / ${history.length}`
      summary.textContent = formatPromptMetadataLine(promptViewFromRecord(entry))
      updateHistoryActionState()
      if (activeLightbox && selectedAvailability !== 'missing') {
        const lightboxImage = activeLightbox.overlay.querySelector('img')
        if (lightboxImage) lightboxImage.src = url
      }
    }

    function renderHistorySurface(): void {
      promptRenderToken++
      surface = 'history'
      modal.setTitle('Generation History')
      setImagePromptOverflow(modal, false)
      modal.root.replaceChildren(container)
      render()
    }

    const step = (direction: -1 | 1) => {
      if (surface !== 'history' || committing) return
      const nextIndex = idx + direction
      if (nextIndex < 0 || nextIndex >= history.length) return
      idx = nextIndex
      render()
    }
    prev.addEventListener('click', event => { event.stopPropagation(); step(-1) })
    next.addEventListener('click', event => { event.stopPropagation(); step(1) })
    const arrowHandler = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (event.ctrlKey || event.metaKey || event.altKey || activeLightbox) return
      // Always isolate arrows while this logical modal is foregrounded. The
      // child Image Prompt surface does not navigate, but Lumiverse must not
      // swipe the underlying chat behind it.
      if (!isEditableTarget(event.target)) event.preventDefault()
      event.stopImmediatePropagation()
      if (surface === 'history' && !committing) step(event.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', arrowHandler, { capture: true })

    let touchStartX = 0
    let touchStartY = 0
    previewWrap.addEventListener('touchstart', event => {
      const touch = event.touches[0]
      if (!touch) return
      touchStartX = touch.clientX
      touchStartY = touch.clientY
    }, { passive: true })
    previewWrap.addEventListener('touchend', event => {
      if (surface !== 'history') return
      const touch = event.changedTouches[0]
      if (!touch) return
      const dx = touch.clientX - touchStartX
      const dy = touch.clientY - touchStartY
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1)
    }, { passive: true })

    renderHistorySurface()
    modal.onDismiss(() => {
      promptRenderToken++
      if (activeHistoryViewerModal === modal) activeHistoryViewerModal = null
      dismissLightbox()
      window.removeEventListener('keydown', arrowHandler, { capture: true })
    })
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

  // ── View Prompt modal (widget advanced menu) ──
  //
  // Read-only viewer for the last Shutter image's prompt in the last
  // message. Resolution goes through the message markdown (tag path), same
  // as the lightbox pill — messageId '__last__' and index -1 are resolved
  // backend-side, so this works even when the message isn't rendered in the
  // (virtualized) chat DOM. It resolves Shutter's durable record and the
  // provider-embedded metadata independently, then shows one source at a time.

  let promptViewerOpen = false
  let activePromptViewerModal: ModalHandle | null = null

  function viewLastPrompt(): void {
    const chatId = ctx.getActiveChat()?.chatId ?? undefined
    if (!chatId || promptViewerOpen) return
    promptViewerOpen = true

    const modal = ctx.ui.showModal({ title: 'Image Prompt', width: 640, persistent: true }) as ModalHandle
    activePromptViewerModal = modal
    isolateModalInput(modal)
    setImagePromptOverflow(modal, true)
    let dismissed = false

    const container = document.createElement('div')
    container.className = 'sh-prompt-body sh-image-prompt-loading'
    const subtitle = document.createElement('p')
    subtitle.className = 'sh-prompt-subtitle'
    subtitle.textContent = 'Reading saved and embedded prompt metadata.'
    container.appendChild(subtitle)

    const status = document.createElement('div')
    status.className = 'sh-prompt-viewer-status'
    const spinnerSlot = document.createElement('span')
    const statusText = document.createElement('span')
    statusText.textContent = 'Reading prompt…'
    status.append(spinnerSlot, statusText)
    container.appendChild(status)
    let spinnerHandle: { destroy(): void } | null = ctx.components.mountSpinner(spinnerSlot, { size: 14, fast: true })
    const destroySpinner = () => { spinnerHandle?.destroy(); spinnerHandle = null }

    const loadingActions = document.createElement('div')
    loadingActions.className = 'sh-prompt-actions'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'sh-prompt-btn sh-prompt-btn-cancel'
    closeBtn.textContent = 'Close'
    closeBtn.addEventListener('click', () => modal.dismiss())
    loadingActions.appendChild(closeBtn)
    container.appendChild(loadingActions)
    modal.root.appendChild(container)

    modal.onDismiss(() => {
      dismissed = true
      destroySpinner()
      promptViewerOpen = false
      if (activePromptViewerModal === modal) activePromptViewerModal = null
    })

    void (async () => {
      const tag = await comms.resolveShutterTag(chatId, '__last__', -1)
      if (dismissed) return
      if (!tag) {
        destroySpinner()
        statusText.textContent = 'No Shutter image found in the last message.'
        return
      }

      const [record, embedded, resolvedTarget] = await Promise.all([
        comms.getGenerationRecord(chatId, tag.imageId),
        resolveEmbeddedPromptForImage(tag, tag.path),
        comms.resolveGenerationTarget(chatId, '__last__'),
      ])
      const reuseTarget = record?.target ?? resolvedTarget
      const history = record ? await comms.getGenerationHistory(record.target) : []
      if (dismissed) return
      destroySpinner()

      const shutterView = record ? promptViewFromRecord(record) : null
      const embeddedView = embedded ? promptViewFromEmbedded(embedded.prompt, embedded.negativePrompt) : null
      if (!shutterView && !embeddedView) {
        subtitle.textContent = 'No saved or embedded prompt metadata is available for this image.'
        status.remove()
        return
      }

      const initialView = shutterView ?? embeddedView!
      renderImagePromptSurface(modal, {
        initialView,
        shutterView,
        embeddedView,
        onClose: () => modal.dismiss(),
        historyLabel: history.length > 0 ? `View History · ${history.length}` : undefined,
        onViewHistory: history.length > 0
          ? () => openHistoryViewer(history, tag.imageId, {
              closeParentPrompt: () => modal.dismiss(),
            })
          : undefined,
        onUsePrompt: reuseTarget
          ? (view) => {
              if (!view.prompt.trim()) return
              modal.dismiss()
              openPromptPreviewModal(view.prompt, view.negativePrompt, reuseTarget, false, false, 'preview')
            }
          : undefined,
      })
    })()
  }

  function openPromptPreviewModal(initialPrompt: string, initialNegative: string, target: GenerationTarget, isAuto = false, replace = false, origin: GenerationOrigin = 'preview') {
    if (promptPreviewOpen) return
    promptPreviewOpen = true
    const modal = ctx.ui.showModal({ title: 'Preview & Edit Image Prompt', width: 640, persistent: true })
    isolateModalInput(modal)
    // Reset the gate on every dismissal path — Cancel, Generate, the header
    // close button, and Escape — so a dismissed preview can never wedge
    // future generations.
    modal.onDismiss(() => { promptPreviewOpen = false })
    function closePromptModal() {
      modal.dismiss()
    }
    const container = document.createElement('div')
    container.className = 'sh-prompt-body'

    const subtitle = document.createElement('div')
    subtitle.className = 'sh-prompt-subtitle'
    subtitle.textContent = 'Review or edit the prompt below. Generate sends it exactly as written.'
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
    generateBtn.disabled = !initialPrompt.trim()
    promptTextarea.addEventListener('input', () => {
      if (!promptTextarea.disabled) generateBtn.disabled = !promptTextarea.value.trim()
    })

    rerunBtn.addEventListener('click', async () => {
    closePromptModal()
    deps.setGeneratingState(true)

    try {
      const result = await deps.callPreviewPrompt(target.chatId)

      deps.setGeneratingState(false)
      openPromptPreviewModal(
        result.prompt,
        result.negativePrompt,
        target,
        isAuto,
        replace,
        origin,
      )
    } catch (err: any) {
      deps.setGeneratingState(false)
      showErrorModal(deps.parseErrorMessage(err.message))
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

      deps.setGeneratingState(true)
      try {
        const result = await deps.callImageGen(target.chatId, {
          prompt,
          negativePrompt: negTextarea.value,
          skipParse: true,
        }, target)
        // skipParse routes to 'custom' prompt mode server-side (no scene, so
        // no skip path), but handle the outcome defensively anyway.
        if ('skipped' in result) {
          deps.setGeneratingState(false)
          if (!isAuto) deps.notifyGenerationSkipped(result.reason)
          return
        }
        await deps.handleGenerationResult(result, target, isAuto, replace, origin)
      } catch (err: any) {
        deps.setGeneratingState(false)
        showErrorModal(deps.parseErrorMessage(err.message))
      }
    })

    actions.appendChild(cancelBtn)
    actions.appendChild(rerunBtn)
    actions.appendChild(generateBtn)
    container.appendChild(actions)
    modal.root.appendChild(container)
  }


  return {
    openDestinationModal,
    openHistoryViewer,
    openPromptPreviewModal,
    showErrorModal,
    viewLastPrompt,
    isPromptPreviewOpen: () => promptPreviewOpen,
    onHistoryCleared: () => {
      activeDestinationModal?.dismiss()
      activeHistoryViewerModal?.dismiss()
      activePromptViewerModal?.dismiss()
    },
    dispose: () => {
      activeDestinationModal?.dismiss()
      activeHistoryViewerModal?.dismiss()
      activePromptViewerModal?.dismiss()
      dismissLightbox()
    },
  }
}
