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
  humaniseGenerationOrigin,
  humanisePromptMode,
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

  type ModalHandle = {
    root: HTMLElement
    dismiss(): void
    setTitle?(title: string): void
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

  function modalHostHeader(modal: ModalHandle): HTMLElement | null {
    const hostBody = modal.root.parentElement
    const hostHeader = hostBody?.previousElementSibling
    return hostHeader instanceof HTMLElement ? hostHeader : null
  }

  function setModalTitle(modal: ModalHandle, title: string): void {
    // Current Spindle exposes setTitle(), but older/mobile hosts may not. Keep
    // the logical history -> prompt surface swap working in either case.
    try {
      if (typeof modal.setTitle === 'function') {
        modal.setTitle(title)
        return
      }
    } catch {
      // Fall through to the host header title element.
    }

    const titleElement = modalHostHeader(modal)?.querySelector('h3')
    if (titleElement) titleElement.textContent = title
  }

  function mountModalHeaderClose(modal: ModalHandle, onClick: () => void): void {
    const hostHeader = modalHostHeader(modal)
    if (!hostHeader) return

    // Shared component mounts are restricted to extension-owned DOM. The modal
    // header belongs to Lumiverse, so mounting ctx.components here throws and
    // leaves an empty shell on mobile. A plain button is safe in host chrome.
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'sh-modal-header-close-native'
    button.setAttribute('aria-label', 'Close')
    button.title = 'Close'
    Object.assign(button.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
      background: 'none',
      border: 'none',
      color: 'var(--lumiverse-text-dim)',
      cursor: 'pointer',
      padding: '4px',
      borderRadius: '4px',
      lineHeight: '0',
    })
    button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

    const handleClick = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      onClick()
    }
    button.addEventListener('click', handleClick)
    hostHeader.appendChild(button)

    modal.onDismiss(() => {
      button.removeEventListener('click', handleClick)
      button.remove()
    })
  }

  function constrainImagePromptModal(modal: ModalHandle): void {
    const hostBody = modal.root.parentElement
    if (hostBody instanceof HTMLElement) {
      hostBody.style.overflowY = 'hidden'
      hostBody.style.minHeight = '0'
      hostBody.style.display = 'flex'
      hostBody.style.flexDirection = 'column'
    }
    modal.root.classList.add('sh-image-prompt-root')
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
      historyLabel?: string
      onViewHistory?: () => void
    },
  ): void {
    constrainImagePromptModal(modal)
    setModalTitle(modal, 'Image Prompt')

    let activeView = options.initialView
    const body = document.createElement('div')
    body.className = 'sh-prompt-body sh-image-prompt-body'

    const sourceSlot = document.createElement('div')
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

      const details = [view.source === 'shutter' ? 'Saved by Shutter' : 'Embedded in image']
      if (view.createdAt) details.push(new Date(view.createdAt).toLocaleString())
      if (view.promptMode) details.push(`Mode: ${humanisePromptMode(view.promptMode)}`)
      if (view.origin) details.push(`Action: ${humaniseGenerationOrigin(view.origin)}`)
      meta.textContent = details.join(' · ')

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
    closeBtn.textContent = 'Close'
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

  function makeDestBtn(label: string, tooltip: string, variant: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button')
    btn.className = `sh-prompt-btn ${variant}`
    btn.textContent = label
    btn.title = tooltip
    btn.addEventListener('click', onClick)
    return btn
  }

  // ── Durable generation history (1.0.7) ──
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

    const previewWrap = document.createElement('div')
    previewWrap.className = 'sh-preview'
    const preview = document.createElement('img')
    preview.src = imageUrlForHistoryRecord(current())
    preview.addEventListener('click', () => openLightbox(imageUrlForHistoryRecord(current())))
    previewWrap.appendChild(preview)

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

    function renderHistory() {
      const entry = current()
      const url = imageUrlForHistoryRecord(entry)
      preview.src = url
      if (activeLightbox) {
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
    const insertBtn = makeDestBtn('Insert', 'Insert the selected image into its message response', 'sh-prompt-btn-primary', () => {
      if (insertBtn.getAttribute('aria-busy') === 'true') return
      insertBtn.setAttribute('aria-busy', 'true')
      for (const button of Array.from(choices.querySelectorAll('button'))) button.disabled = true
      void comms.insertIntoMessage({
        imageId: current().imageId,
        messageId: target.messageId,
        chatId: target.chatId,
        target,
        replace: replaceChecked,
      }).then(result => {
        if (!modal.root.isConnected) return
        if (result.success) {
          modal.dismiss()
          return
        }
        insertBtn.removeAttribute('aria-busy')
        for (const button of Array.from(choices.querySelectorAll('button'))) button.disabled = false
      })
    })
    choices.appendChild(insertBtn)
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
    closeUnderlyingLightbox?: () => void,
    closeParentPrompt?: () => void,
  ): void {
    const history = [...records].sort((a, b) => a.createdAt - b.createdAt || a.imageId.localeCompare(b.imageId))
    if (history.length === 0) return

    activeHistoryViewerModal?.dismiss()
    let idx = history.findIndex(entry => entry.imageId === initialImageId)
    if (idx < 0) idx = history.length - 1
    const current = () => history[idx]!

    // This is the second and final physical modal in the widget flow. The
    // history prompt reuses this handle by swapping its body and title, so the
    // logical three-level flow never exceeds Spindle's two-modal limit.
    const modal = ctx.ui.showModal({ title: 'Generation History', width: 640, persistent: true }) as ModalHandle
    activeHistoryViewerModal = modal
    let surface: 'history' | 'prompt' = 'history'
    let committing = false

    const closeCurrentSurface = () => {
      if (surface === 'prompt') renderHistorySurface()
      else modal.dismiss()
    }
    isolateModalInput(modal, { blockArrows: false, onEscape: closeCurrentSurface })
    mountModalHeaderClose(modal, closeCurrentSurface)

    const container = document.createElement('div')
    container.className = 'sh-modal-body'
    const previewWrap = document.createElement('div')
    previewWrap.className = 'sh-preview'
    const preview = document.createElement('img')
    preview.addEventListener('click', () => openLightbox(imageUrlForHistoryRecord(current())))
    previewWrap.appendChild(preview)

    const nav = document.createElement('div')
    nav.className = 'sh-hist-pill'
    nav.addEventListener('click', event => event.stopPropagation())
    const prev = document.createElement('button')
    const next = document.createElement('button')
    prev.type = next.type = 'button'
    prev.className = next.className = 'sh-hist-btn'
    prev.title = 'Previous generation'
    next.title = 'Next generation'
    prev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>'
    next.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'
    const count = document.createElement('span')
    count.className = 'sh-hist-counter'
    nav.append(prev, count, next)
    previewWrap.appendChild(nav)
    container.appendChild(previewWrap)

    const summary = document.createElement('div')
    summary.className = 'sh-history-summary'
    container.appendChild(summary)

    const actions = document.createElement('div')
    actions.className = 'sh-prompt-actions sh-history-actions'

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'sh-prompt-btn sh-prompt-btn-cancel'
    closeBtn.textContent = 'Close'
    closeBtn.addEventListener('click', () => modal.dismiss())

    const viewPromptBtn = document.createElement('button')
    viewPromptBtn.type = 'button'
    viewPromptBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary'
    viewPromptBtn.textContent = 'View Prompt'
    viewPromptBtn.title = 'View and copy the prompt saved for this generation'
    viewPromptBtn.addEventListener('click', () => {
      if (committing) return
      surface = 'prompt'
      renderImagePromptSurface(modal, {
        initialView: promptViewFromRecord(current()),
        onClose: renderHistorySurface,
      })
    })

    const replaceBtn = document.createElement('button')
    replaceBtn.type = 'button'
    replaceBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary'
    replaceBtn.textContent = 'Replace'
    replaceBtn.title = 'Replace the image that opened Generation History'

    const insertBtn = document.createElement('button')
    insertBtn.type = 'button'
    insertBtn.className = 'sh-prompt-btn sh-prompt-btn-primary'
    insertBtn.textContent = 'Insert'
    insertBtn.title = 'Insert this image into its original message response'

    const setCommitDisabled = (disabled: boolean) => {
      committing = disabled
      for (const button of [closeBtn, viewPromptBtn, replaceBtn, insertBtn, prev, next]) button.disabled = disabled
    }

    const commitSelected = async (replace: boolean) => {
      if (committing) return
      setCommitDisabled(true)
      const entry = current()
      const result = await comms.insertIntoMessage({
        imageId: entry.imageId,
        messageId: entry.target.messageId,
        chatId: entry.target.chatId,
        target: entry.target,
        replace,
        // History was opened from a concrete lightbox image. Replace that
        // exact tag, not whichever Shutter image happens to be last now.
        replaceImageId: replace ? initialImageId : undefined,
      })
      if (!modal.root.isConnected) return
      if (!result.success) {
        setCommitDisabled(false)
        render()
        return
      }

      modal.dismiss()
      closeParentPrompt?.()
      closeUnderlyingLightbox?.()
    }
    replaceBtn.addEventListener('click', () => { void commitSelected(true) })
    insertBtn.addEventListener('click', () => { void commitSelected(false) })

    actions.append(closeBtn, viewPromptBtn, replaceBtn, insertBtn)
    container.appendChild(actions)

    function render(): void {
      const entry = current()
      preview.src = imageUrlForHistoryRecord(entry)
      count.textContent = `${idx + 1} / ${history.length}`
      prev.disabled = committing || idx === 0
      next.disabled = committing || idx === history.length - 1
      const metaParts = [new Date(entry.createdAt).toLocaleString()]
      if (entry.promptMode) metaParts.push(`Mode: ${humanisePromptMode(entry.promptMode)}`)
      if (entry.origin) metaParts.push(`Action: ${humaniseGenerationOrigin(entry.origin)}`)
      summary.textContent = metaParts.join(' · ')
      if (activeLightbox) {
        const lightboxImage = activeLightbox.overlay.querySelector('img')
        if (lightboxImage) lightboxImage.src = imageUrlForHistoryRecord(entry)
      }
    }

    function renderHistorySurface(): void {
      surface = 'history'
      setModalTitle(modal, 'Generation History')
      modal.root.classList.remove('sh-image-prompt-root')
      const hostBody = modal.root.parentElement
      if (hostBody instanceof HTMLElement) {
        hostBody.style.overflowY = 'auto'
        hostBody.style.display = ''
        hostBody.style.flexDirection = ''
        hostBody.style.minHeight = ''
      }
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
      if (surface !== 'history') return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (event.ctrlKey || event.metaKey || event.altKey || activeLightbox || isEditableTarget(event.target)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      step(event.key === 'ArrowLeft' ? -1 : 1)
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
    let dismissed = false
    const closePrompt = () => modal.dismiss()
    isolateModalInput(modal, { onEscape: closePrompt })
    mountModalHeaderClose(modal, closePrompt)
    constrainImagePromptModal(modal)

    const loadingBody = document.createElement('div')
    loadingBody.className = 'sh-prompt-body sh-image-prompt-body sh-image-prompt-loading-body'
    const status = document.createElement('div')
    status.className = 'sh-prompt-viewer-status'
    const spinnerSlot = document.createElement('span')
    const statusText = document.createElement('span')
    statusText.textContent = 'Reading prompt…'
    status.append(spinnerSlot, statusText)
    const loadingActions = document.createElement('div')
    loadingActions.className = 'sh-prompt-actions sh-image-prompt-actions'
    const loadingCloseBtn = document.createElement('button')
    loadingCloseBtn.type = 'button'
    loadingCloseBtn.className = 'sh-prompt-btn sh-prompt-btn-cancel'
    loadingCloseBtn.textContent = 'Close'
    loadingCloseBtn.addEventListener('click', closePrompt)
    loadingActions.appendChild(loadingCloseBtn)
    loadingBody.append(status, loadingActions)
    modal.root.replaceChildren(loadingBody)

    let spinnerHandle: { destroy(): void } | null = ctx.components.mountSpinner(spinnerSlot, { size: 14, fast: true })
    const destroySpinner = () => { spinnerHandle?.destroy(); spinnerHandle = null }

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

      const [record, embedded] = await Promise.all([
        comms.getGenerationRecord(tag.imageId),
        resolveEmbeddedPromptForImage(tag, tag.path),
      ])
      const history = record ? await comms.getGenerationHistory(record.target) : []
      if (dismissed) return
      destroySpinner()

      const shutterView = record ? promptViewFromRecord(record) : null
      const embeddedView = embedded ? promptViewFromEmbedded(embedded.prompt, embedded.negativePrompt) : null
      const initialView = shutterView ?? embeddedView
      if (!initialView) {
        statusText.textContent = 'No saved or embedded prompt metadata is available for this image.'
        return
      }

      renderImagePromptSurface(modal, {
        initialView,
        shutterView,
        embeddedView,
        onClose: closePrompt,
        historyLabel: history.length > 0 ? `View History · ${history.length}` : undefined,
        onViewHistory: history.length > 0
          ? () => openHistoryViewer(history, tag.imageId, undefined, closePrompt)
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
