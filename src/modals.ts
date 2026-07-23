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
import { resolvePromptForImage, type ResolvedPrompt } from './metadata'
import { COPY_CHECK_SVG } from './styles'

export function createModals(deps: {
  ctx: SpindleFrontendContext
  comms: Comms
  getSettings: () => Settings | null
  triggerGenerate: (messageId?: string, chatId?: string, isAuto?: boolean, replace?: boolean, force?: boolean) => void
  handleGenerationResult: (result: GenerationResult, messageId: string, chatId: string, isAuto: boolean, replace?: boolean) => void
  setGeneratingState: (active: boolean) => void
  callImageGen: (chatId: string, overrides?: Record<string, any>) => Promise<GenerationResult | GenerationSkipped>
  callPreviewPrompt: (chatId: string) => Promise<{ prompt: string; negativePrompt: string }>
  notifyGenerationSkipped: (reason: string) => void
  parseErrorMessage: (raw: string) => string
}) {
  const { ctx, comms } = deps

  let promptPreviewOpen = false

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

  function makeDestBtn(label: string, tooltip: string, variant: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button')
    btn.className = `sh-prompt-btn ${variant}`
    btn.textContent = label
    btn.title = tooltip
    btn.addEventListener('click', onClick)
    return btn
  }

  // ── Generation history (1.0.7) ──
  //
  // Every generation is already persisted server-side with a stable imageId
  // (regenerating never deletes the previous result), so history is pure
  // client-side bookkeeping. Scope is one *prompt cycle*: only Regenerate
  // Image continues a session (it re-enters the modal without going through
  // triggerGenerate); Rebuild Prompt, a fresh widget trigger, or
  // auto-generate all start a clean one. Keying by chat/message doesn't work
  // here — widget-triggered generations have no messageId until insert time
  // ('__last__' is resolved backend-side), so every generation in a chat
  // would share one key and swipes/new messages would inherit stale images.

  type GenHistoryEntry = { imageId: string; imageUrl: string; prompt: string; negativePrompt: string }
  const GEN_HISTORY_CAP = 10
  let genSession: GenHistoryEntry[] = []
  // Set immediately before the Regenerate path re-enters
  // handleGenerationResult → openDestinationModal; consumed on open.
  let continueGenSession = false

  function openDestinationModal(imageId: string, imageUrl: string, messageId: string, chatId: string, prompt: string, negativePrompt: string, isAuto: boolean, replace = false) {
    // Feature tiers (both default off): Generation History enables the pill,
    // session retention, and chevron navigation including spawn-past-the-end
    // (chevrons always work, mirroring native SwipeControls). Gesture
    // Navigation (child) additionally enables the touch-swipe and arrow-key
    // input channels, mirroring native swipeGesturesEnabled. With history off
    // the modal is exactly the pre-1.0.7 flow — single image, no pill, no
    // gesture/keyboard capture.
    const settings = deps.getSettings()
    const historyEnabled = settings?.generationHistory === true
    const gestureEnabled = historyEnabled && settings?.gestureNavigation === true

    // Continue the session only when re-entered via Regenerate Image;
    // every other arrival is a new prompt cycle and starts clean.
    if (!historyEnabled || !continueGenSession) genSession = []
    continueGenSession = false

    const history = genSession
    if (history[history.length - 1]?.imageId !== imageId) {
      history.push({ imageId, imageUrl, prompt, negativePrompt })
      if (history.length > GEN_HISTORY_CAP) history.shift()
    }
    let idx = history.length - 1
    const current = () => history[idx]!

    const modal = ctx.ui.showModal({ title: 'Image Generated', width: 640, persistent: true })
    const container = document.createElement('div')
    container.className = 'sh-modal-body'

    const previewWrap = document.createElement('div')
    previewWrap.className = 'sh-preview'
    const preview = document.createElement('img')
    preview.src = imageUrl
    preview.addEventListener('click', () => openLightbox(current().imageUrl))
    previewWrap.appendChild(preview)

    // History navigation — a single pill mirroring the native swipe-controls
    // bubble (chevrons + tabular counter). Always visible, like native at
    // 1 / 1: the right chevron past the end spawns a new generation, so the
    // pill is the affordance for "another one" even before history exists.
    const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>'
    const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'
    const makeNavBtn = (dir: -1 | 1): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'sh-hist-btn'
      btn.innerHTML = dir === -1 ? CHEVRON_LEFT : CHEVRON_RIGHT
      btn.title = dir === -1 ? 'Previous generation' : 'Next generation'
      btn.addEventListener('click', (e) => {
        e.stopPropagation() // don't trip the preview's lightbox handler
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
    histPill.addEventListener('click', (e) => e.stopPropagation())
    histPill.appendChild(navPrev)
    histPill.appendChild(histCount)
    histPill.appendChild(navNext)
    if (historyEnabled) previewWrap.appendChild(histPill)
    container.appendChild(previewWrap)

    function renderHistory() {
      const entry = current()
      preview.src = entry.imageUrl
      // If the mini lightbox is open, keep it in sync with the selection.
      if (activeLightbox) {
        const img = activeLightbox.overlay.querySelector('img')
        if (img) img.src = entry.imageUrl
      }
      // Always visible within the history tier, like native at 1 / 1: the
      // right chevron past the end spawns a new generation regardless of the
      // Gesture Navigation setting (chevrons are the feature; gestures are
      // extra input channels).
      navPrev.disabled = idx === 0
      const atEnd = idx === history.length - 1
      // Past-the-end spawns a new generation (native swipe semantics), so
      // the right chevron stays live at the end — disabled only if the
      // prompt needed to regenerate was never returned.
      const canRegen = !!history[history.length - 1]!.prompt.trim()
      navNext.disabled = atEnd && !canRegen
      navNext.title = atEnd ? 'Regenerate image (same prompt)' : 'Next generation'
      histCount.textContent = `${idx + 1} / ${history.length}`
    }

    // Shared by the Regenerate Image button and past-the-end navigation
    // (right chevron / ArrowRight / swipe-left at the last entry). Follows
    // the existing flow deliberately: dismiss first, hand generating state
    // to the widget spinner, reopen with the appended result.
    let regenerating = false
    async function regenerateFromSelected() {
      if (regenerating) return
      const selected = current()
      const resolvedPrompt = selected.prompt.trim()
      if (!resolvedPrompt) {
        modal.dismiss()
        showErrorModal('Cannot regenerate because the resolved prompt was not returned by native ImageGen.')
        return
      }

      regenerating = true
      modal.dismiss()
      deps.setGeneratingState(true)
      try {
        const result = await deps.callImageGen(chatId, {
          prompt: resolvedPrompt,
          negativePrompt: selected.negativePrompt,
          skipParse: true,
        })
        // skipParse routes to 'custom' prompt mode server-side (no scene, so
        // no skip path), but handle the outcome defensively anyway.
        if ('skipped' in result) {
          deps.setGeneratingState(false)
          deps.notifyGenerationSkipped(result.reason)
          return
        }
        continueGenSession = true
        deps.handleGenerationResult(result, messageId, chatId, isAuto, replaceChecked)
      } catch (err: any) {
        deps.setGeneratingState(false)
        showErrorModal(deps.parseErrorMessage(err.message))
      }
    }

    function stepHistory(dir: -1 | 1) {
      const next = idx + dir
      if (next >= history.length) {
        // Stepping past the last entry = "give me another one" — mirrors
        // native SwipeControls, where swiping right past the last swipe
        // spawns a new generation. Regenerates with the end entry's prompt.
        void regenerateFromSelected()
        return
      }
      if (next < 0) return
      idx = next
      renderHistory()
    }

    // Capture-phase, window-level: Lumiverse's swipe hotkeys are a global
    // document-level keydown listener whose modal guard only knows about
    // native modals (state.activeModal), not Spindle ones — so while this
    // modal is up, arrows must be consumed before they reach it, or paging
    // history would also swipe the assistant message underneath. Consumed
    // even at 1/1 so a locked-foreground modal never leaks arrows to chat.
    const arrowHandler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.ctrlKey || e.metaKey || e.altKey) return // leave browser/OS combos alone
      const active = document.activeElement as HTMLElement | null
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
      e.preventDefault()
      e.stopPropagation()
      stepHistory(e.key === 'ArrowLeft' ? -1 : 1)
    }
    // Installed only when Gesture Navigation is on — that setting is the
    // arrow-key channel, mirroring native swipeGesturesEnabled. When off,
    // native chat swipes keep their keys (the pre-1.0.7 state).
    if (gestureEnabled) window.addEventListener('keydown', arrowHandler, { capture: true })

    // Touch swipe on the preview — same feel as the native message gesture
    // (useSwipeGesture): 10px dead-zone axis lock, then 50px displacement or
    // 0.3px/ms velocity. preventDefault on horizontal lock also suppresses
    // the synthetic click, so a swipe never opens the lightbox.
    let touchStartX = 0, touchStartY = 0, touchStartT = 0
    let touchLock: 'h' | 'v' | null = null
    if (gestureEnabled) {
      previewWrap.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) { touchLock = 'v'; return }
        const t = e.touches[0]!
        touchStartX = t.clientX; touchStartY = t.clientY; touchStartT = Date.now()
        touchLock = null
      }, { passive: true })
      previewWrap.addEventListener('touchmove', (e) => {
        if (touchLock) { if (touchLock === 'h') e.preventDefault(); return }
        const t = e.touches[0]!
        const dx = t.clientX - touchStartX, dy = t.clientY - touchStartY
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
        touchLock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
        if (touchLock === 'h') e.preventDefault()
      }, { passive: false })
      previewWrap.addEventListener('touchend', (e) => {
        if (touchLock !== 'h') return
        const t = e.changedTouches[0]!
        const dx = t.clientX - touchStartX
        const dt = Math.max(Date.now() - touchStartT, 1)
        if (Math.abs(dx) >= 50 || Math.abs(dx) / dt >= 0.3) {
          stepHistory(dx < 0 ? 1 : -1) // content follows finger: swipe left → next
        }
      }, { passive: true })
    }

    // Replace checkbox
    let replaceChecked = replace || (deps.getSettings()?.defaultAction === 'replace')
    const replaceSlot = document.createElement('div')
    replaceSlot.className = 'sh-replace-row'
    const replaceCheckbox = ctx.components.mountCheckbox(replaceSlot, {
      checked: replaceChecked,
      label: 'Replace existing image',
      onChange: (on: boolean) => {
        replaceChecked = on
      },
    })
    container.appendChild(replaceSlot)

    const choices = document.createElement('div')
    choices.className = 'sh-prompt-actions'
    choices.appendChild(makeDestBtn('Done', 'Close without inserting', 'sh-prompt-btn-cancel', () => {
      modal.dismiss()
    }))
    choices.appendChild(makeDestBtn('Rebuild Prompt', 'Re-parse the chat and generate a new prompt', 'sh-prompt-btn-secondary', () => {
      modal.dismiss()
      deps.triggerGenerate(messageId, chatId, isAuto, replaceChecked)
    }))
    choices.appendChild(makeDestBtn('Regenerate Image', 'Generate again with the selected image\u2019s prompt', 'sh-prompt-btn-secondary', () => {
      void regenerateFromSelected()
    }))
    choices.appendChild(makeDestBtn('Insert', 'Append the selected image to the last message', 'sh-prompt-btn-primary', () => {
      ctx.sendToBackend({ type: 'insert_into_message', imageId: current().imageId, messageId, chatId, replace: replaceChecked })
      modal.dismiss()
    }))
    container.appendChild(choices)
    modal.root.appendChild(container)

    renderHistory()

    modal.onDismiss(() => {
      window.removeEventListener('keydown', arrowHandler, { capture: true })
      replaceCheckbox.destroy()
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
  // (virtualized) chat DOM. Ethos-consistent: metadata is fetched and parsed
  // on this explicit request only; nothing is stored.

  let promptViewerOpen = false

  function viewLastPrompt(): void {
    const chatId = ctx.getActiveChat()?.chatId ?? undefined
    if (!chatId) return
    if (promptViewerOpen) return
    promptViewerOpen = true

    const modal = ctx.ui.showModal({ title: 'Image Prompt', width: 640 })
    let dismissed = false

    const container = document.createElement('div')
    container.className = 'sh-prompt-body'

    // Subtitle: parity with the Preview & Edit modal, and documents where
    // the prompt comes from (embedded metadata, nothing stored).
    const subtitle = document.createElement('p')
    subtitle.className = 'sh-prompt-subtitle'
    subtitle.textContent = 'Read from the image\u2019s embedded generation metadata.'
    container.appendChild(subtitle)

    // Loading state: host spinner + status line, swapped in place on resolve.
    const status = document.createElement('div')
    status.className = 'sh-prompt-viewer-status'
    const spinnerSlot = document.createElement('span')
    const statusText = document.createElement('span')
    statusText.textContent = 'Reading prompt…'
    status.appendChild(spinnerSlot)
    status.appendChild(statusText)
    container.appendChild(status)
    let spinnerHandle: { destroy(): void } | null = ctx.components.mountSpinner(spinnerSlot, { size: 14, fast: true })
    const destroySpinner = () => { spinnerHandle?.destroy(); spinnerHandle = null }

    modal.root.appendChild(container)
    modal.onDismiss(() => {
      dismissed = true
      destroySpinner()
      promptViewerOpen = false
    })

    const makeField = (label: string, text: string, short = false) => {
      const field = document.createElement('div')
      field.className = 'sh-prompt-field'
      const heading = document.createElement('div')
      heading.className = 'sh-prompt-label'
      heading.textContent = label
      const block = document.createElement('div')
      block.className = short ? 'sh-prompt-readonly sh-prompt-readonly-short' : 'sh-prompt-readonly'
      block.textContent = text
      field.appendChild(heading)
      field.appendChild(block)
      return field
    }

    const makeActions = (resolved: ResolvedPrompt | null) => {
      const actions = document.createElement('div')
      actions.className = 'sh-prompt-actions'
      if (resolved) {
        const copyBtn = document.createElement('button')
        copyBtn.type = 'button'
        copyBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary'
        copyBtn.textContent = 'Copy'
        copyBtn.addEventListener('click', () => {
          const text = resolved.negativePrompt
            ? `${resolved.prompt}\n\nNegative prompt: ${resolved.negativePrompt}`
            : resolved.prompt
          // Mirrors the lightbox pill's confirmation: checkmark + success
          // color for 2000ms via the shared sh-copied class.
          navigator.clipboard.writeText(text).then(() => {
            copyBtn.innerHTML = `${COPY_CHECK_SVG} Copied`
            copyBtn.classList.add('sh-copied')
            setTimeout(() => {
              if (!copyBtn.isConnected) return
              copyBtn.textContent = 'Copy'
              copyBtn.classList.remove('sh-copied')
            }, 2000)
          }).catch(() => {
            copyBtn.textContent = 'Failed'
            setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = 'Copy' }, 1200)
          })
        })
        actions.appendChild(copyBtn)
      }
      const closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.className = 'sh-prompt-btn sh-prompt-btn-cancel'
      closeBtn.textContent = 'Close'
      closeBtn.addEventListener('click', () => modal.dismiss())
      actions.appendChild(closeBtn)
      return actions
    }

    const showMessage = (text: string) => {
      statusText.textContent = text
      container.appendChild(makeActions(null))
    }

    void (async () => {
      const tag = await comms.resolveShutterTag(chatId, '__last__', -1)
      if (dismissed) return
      if (!tag) {
        destroySpinner()
        spinnerSlot.remove()
        showMessage('No Shutter image found in the last message.')
        return
      }
      const resolved = await resolvePromptForImage(tag, tag.path)
      if (dismissed) return
      destroySpinner()
      if (!resolved) {
        spinnerSlot.remove()
        showMessage('No readable prompt metadata in this image.')
        return
      }
      status.remove()
      container.appendChild(makeField('Prompt', resolved.prompt))
      if (resolved.negativePrompt) {
        container.appendChild(makeField('Negative Prompt', resolved.negativePrompt, true))
      }
      container.appendChild(makeActions(resolved))
    })()
  }

  function openPromptPreviewModal(initialPrompt: string, initialNegative: string, chatId: string, messageId?: string, isAuto = false, replace = false) {
    if (promptPreviewOpen) return
    promptPreviewOpen = true
    const modal = ctx.ui.showModal({ title: 'Preview & Edit Image Prompt', width: 640, persistent: true })
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
      const result = await deps.callPreviewPrompt(chatId)

      deps.setGeneratingState(false)
      openPromptPreviewModal(
        result.prompt,
        result.negativePrompt,
        chatId,
        messageId,
        isAuto,
        replace,
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
        const result = await deps.callImageGen(chatId, {
          prompt,
          negativePrompt: negTextarea.value,
          skipParse: true,
        })
        // skipParse routes to 'custom' prompt mode server-side (no scene, so
        // no skip path), but handle the outcome defensively anyway.
        if ('skipped' in result) {
          deps.setGeneratingState(false)
          if (!isAuto) deps.notifyGenerationSkipped(result.reason)
          return
        }
        deps.handleGenerationResult(result, messageId || '__last__', chatId, isAuto, replace)
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
    openPromptPreviewModal,
    showErrorModal,
    viewLastPrompt,
    isPromptPreviewOpen: () => promptPreviewOpen,
    // Entry cleanup: the mini lightbox is the only modal surface with
    // document-level listeners to release (host modals clean themselves up).
    dispose: dismissLightbox,
  }
}
