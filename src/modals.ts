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

  function openDestinationModal(imageId: string, imageUrl: string, messageId: string, chatId: string, prompt: string, negativePrompt: string, isAuto: boolean, replace = false) {
    const modal = ctx.ui.showModal({ title: 'Image Generated', width: 640, persistent: true })
    const container = document.createElement('div')
    container.className = 'sh-modal-body'

    const previewWrap = document.createElement('div')
    previewWrap.className = 'sh-preview'
    const preview = document.createElement('img')
    preview.src = imageUrl
    preview.addEventListener('click', () => openLightbox(imageUrl))
    previewWrap.appendChild(preview)
    container.appendChild(previewWrap)

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
    choices.appendChild(makeDestBtn('Regenerate Image', 'Generate again with the same prompt', 'sh-prompt-btn-secondary', async () => {
      const resolvedPrompt = prompt.trim()
      if (!resolvedPrompt) {
        modal.dismiss()
        showErrorModal('Cannot regenerate because the resolved prompt was not returned by native ImageGen.')
        return
      }

      modal.dismiss()
      deps.setGeneratingState(true)
      try {
        const result = await deps.callImageGen(chatId, {
          prompt: resolvedPrompt,
          negativePrompt,
          skipParse: true,
        })
        // skipParse routes to 'custom' prompt mode server-side (no scene, so
        // no skip path), but handle the outcome defensively anyway.
        if ('skipped' in result) {
          deps.setGeneratingState(false)
          deps.notifyGenerationSkipped(result.reason)
          return
        }
        deps.handleGenerationResult(result, messageId, chatId, isAuto, replaceChecked)
      } catch (err: any) {
        deps.setGeneratingState(false)
        showErrorModal(deps.parseErrorMessage(err.message))
      }
    }))
    choices.appendChild(makeDestBtn('Insert', 'Append to the last message', 'sh-prompt-btn-primary', () => {
      ctx.sendToBackend({ type: 'insert_into_message', imageId, messageId, chatId, replace: replaceChecked })
      modal.dismiss()
    }))
    container.appendChild(choices)
    modal.root.appendChild(container)

    modal.onDismiss(() => {
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
