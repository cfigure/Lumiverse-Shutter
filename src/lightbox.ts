// The lightbox prompt label: click-driven detection of the native image
// lightbox, caption-strip reservation, the body-level prompt pill, and all
// of its geometry/lifecycle machinery. Moved whole from frontend.ts —
// comments and all — because this is the most carefully-tuned code in the
// extension; see the inline notes before changing anything.
//
// Everything below closes over the deps passed to the factory:
//  - ctx            Spindle frontend context (dom, components, getActiveChat)
//  - comms          resolveShutterTag round-trip (comms.ts)
//  - getSettings    live settings (entry owns settings state)
//  - hasPermission  live granted-permissions lookup (entry owns the set)
//
// The entry calls sync() whenever settings or permissions change, and
// dispose() from its cleanup function.

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { Settings } from './settings'
import type { Comms } from './comms'
import { IMAGE_URL_RE, resolveEmbeddedPromptForImage, extractImageId } from './metadata'
import { COPY_CHECK_SVG } from './styles'
import {
  formatPromptMetadataForClipboard,
  formatPromptMetadataLine,
  promptViewFromEmbedded,
  promptViewFromRecord,
  type GenerationHistoryRecord,
  type PromptMetadataView,
} from './history'

type PromptSources = {
  shutter: PromptMetadataView | null
  embedded: PromptMetadataView | null
  history: GenerationHistoryRecord[]
  imageId: string
}

export function createLightboxPromptLabel(deps: {
  ctx: SpindleFrontendContext
  comms: Comms
  getSettings: () => Settings | null
  hasPermission: (permission: string) => boolean
  openHistory: (records: GenerationHistoryRecord[], imageId: string, closeUnderlyingLightbox?: () => void) => void
}) {
  const { ctx, comms } = deps

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // ── Lightbox prompt label (1.0.6) ──
  //
  // Shows the generation prompt below Shutter images opened in the native
  // image lightbox. Gated on the 'app_manipulation' permission and the
  // 'Show Prompt in Lightbox' setting, degrading silently without either
  // (same pattern as the interceptor feature).
  //
  // The native ImageLightbox uses build-hashed class names and no stable
  // component hook, so Shutter identifies lightbox images by matching them
  // back to a clicked chat image rendered from Shutter's ![shutter](...) markdown.
  //
  // Prompt sources:
  //   1. Shutter's durable generation record, when available.
  //   2. Provider-embedded PNG metadata from the original image
  //      (A1111/Forge 'parameters', NovelAI 'Comment'/'Description',
  //      ComfyUI workflow text — best effort).
  // Both are retained independently so the expanded view can switch between
  // exactly what Shutter submitted and what the provider embedded.

  // ── Lightbox detection and label injection ──
  //
  // Detection is click-driven: the only way a Shutter image reaches the
  // native lightbox is the user clicking its chat render, and that click is
  // itself proof of ownership (the handler only fires on img[alt="shutter"],
  // Shutter's stable markdown fingerprint). A short retry sweep then locates
  // the lightbox portal. A MutationObserver was tried first and dropped:
  // host builds can mount the lightbox img with an empty src and set it
  // post-insertion, which childList observation never sees.

  let lightboxWatcherActive = false

  // Caption geometry, shared by the reserve rules and positionLabel.
  // Desktop prompt width is image-aware but clamped, so landscape images can
  // carry a wider label while portrait images still get a readable minimum.
  // Mobile is capped to image width once the image is laid out.
  //
  // RESERVE = strip height (panel + gap + edge). HYBRID model, decided per
  // image per state:
  //  - If the untouched, centered image already leaves a full strip below
  //    (free height ≤ V − 2R), it is left exactly where native centers it —
  //    no shift, no shrink. This is the common case on phones (width-bound
  //    images), zoomed-out windows, and small gens, where an unconditional
  //    shift bought nothing and read as a pointless nudge.
  //  - Only when the image is genuinely too tall does it pay: the cap is
  //    charged ONCE (V − R) with margin-block-end = reserve, so flex centers
  //    the outer box and the image shifts up rather than shrinking about its
  //    center — keeping ~R more height than a symmetric cap would. The
  //    deliberate, user-initiated shift was judged better than the smaller
  //    centered image (both were built and compared; the symmetric variant
  //    is in git history if the judgment ever flips).
  // The min(imageCase, boundCase) crossover in getPromptMaxHeight falls at
  // exactly the image height where the margin cap starts binding, so panel
  // sizing and mode selection share one boundary.
  const CAPTION_GAP = 8
  const CAPTION_EDGE = 12
  const PROMPT_DESKTOP_MIN_WIDTH = 520
  const PROMPT_DESKTOP_MAX_WIDTH = 860
  const PROMPT_MOBILE_MAX_WIDTH = 520
  const PROMPT_MAX_HEIGHT = 156
  const PROMPT_MOBILE_MAX_HEIGHT = 144
  // Adaptive expanded-height caps (see getPromptMaxHeight); the *_MAX_HEIGHT
  // constants above remain as the floors so small screens keep the legacy
  // panel size exactly.
  const PROMPT_EXPANDED_MAX = 480
  const PROMPT_MOBILE_EXPANDED_MAX = 260
  const PROMPT_PILL_HEIGHT = 44
  const PROMPT_PILL_DESKTOP_WIDTH = 360
  const PROMPT_PILL_MOBILE_WIDTH = 320
  // Seed value for the expanded reserve only — the live value is measured
  // from the panel's actual rendered height (content-aware) at expand time.
  const CAPTION_RESERVE = PROMPT_MAX_HEIGHT + CAPTION_GAP + CAPTION_EDGE // 176
  const CAPTION_PILL_RESERVE = PROMPT_PILL_HEIGHT + CAPTION_GAP + CAPTION_EDGE // 64

  // The host zooms every direct body child (`body > * { zoom: var(--lumiverse-ui-scale) }`,
  // reset.css), which includes both the native lightbox portal and our
  // body-injected pill. getBoundingClientRect / window.innerWidth report
  // VISUAL pixels, but any px length written inside the zoom layer renders
  // multiplied by the scale — so all geometry math is done in LOCAL (zoomed)
  // pixels: measurements are divided by the scale on the way in, and the
  // constants above (pill height/widths, prompt heights) are already local
  // px matching the stylesheet. Re-read per call: the user can change the
  // scale live in settings.
  function getUiScale(): number {
    const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale'))
    return Number.isFinite(raw) && raw > 0 ? raw : 1
  }

  function isCompactPromptLayout(): boolean {
    return (window.innerWidth / getUiScale()) <= 560 ||
      (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
  }

  // The expanded panel is sized against the IMAGE, not the viewport: a
  // caption should read as subordinate to what it captions. Panel height ≤
  // PROMPT_IMAGE_RATIO × the image's rendered height. Two cases:
  //  - Image smaller than the viewport allows (zoomed-out windows, low-res
  //    gens): the image won't move, so the ratio applies to its current
  //    height directly. A viewport-relative rule fails exactly here — the
  //    panel would size against empty space and dwarf a small image.
  //  - Height-bound image: expanding shrinks the image, so k × (current
  //    height) would overshoot the final ratio. Solving the feedback —
  //    panel = k(V − gaps)/(1 + k) — lands at exactly k after the image
  //    yields the reserve, and recomputing post-shrink returns the same
  //    value (k·(V − R) = boundCase when R = boundCase + gaps), so the
  //    positioning passes are stable.
  // The floor keeps tiny viewports readable; the cap is a rare absolute
  // ceiling for enormous screens.
  const PROMPT_IMAGE_RATIO = 0.35

  function getPromptMaxHeight(imgLocalHeight?: number): number {
    const localViewportH = window.innerHeight / getUiScale()
    const compact = isCompactPromptLayout()
    const floor = compact ? PROMPT_MOBILE_MAX_HEIGHT : PROMPT_MAX_HEIGHT
    const cap = compact ? PROMPT_MOBILE_EXPANDED_MAX : PROMPT_EXPANDED_MAX
    const k = PROMPT_IMAGE_RATIO
    const boundCase = k * (localViewportH - CAPTION_GAP - CAPTION_EDGE) / (1 + k)
    const imageCase = imgLocalHeight && imgLocalHeight > 0 ? k * imgLocalHeight : Infinity
    return Math.round(Math.min(Math.max(Math.min(boundCase, imageCase), floor), cap))
  }

  // iOS Safari/webviews compute `vh` against the LARGEST viewport (toolbars
  // ignored), inflating viewport-relative sizes on exactly the devices with
  // dynamic chrome. Prefer `dvh` where supported; stylesheet rules use
  // double declarations for the same fallback.
  const VIEWPORT_HEIGHT_UNIT =
    (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('height', '100dvh'))
      ? 'dvh'
      : 'vh'

  // Pre-reservation: a stylesheet rule applied AT CLICK TIME, before the
  // lightbox exists, capping any img that shows the clicked src. CSS binds
  // the instant the lightbox img mounts, so even a fully cached image lays
  // out with the caption strip already reserved — there is never a visible
  // resize. (It also matches the chat copy, where the cap is far above its
  // rendered size and therefore inert.) The inline max-block-size in
  // decorateLightbox remains as a backstop for builds that normalize the
  // lightbox URL away from the clicked src.
  let removeReserveStyle: (() => void) | null = null

  function clearReserveStyle(): void {
    if (removeReserveStyle) {
      removeReserveStyle()
      removeReserveStyle = null
    }
  }

  function applyReserveStyle(src: string): void {
    clearReserveStyle()
    const escaped = src.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    removeReserveStyle = ctx.dom.addStyle(
      // Single reserve + bottom margin (see the caption geometry comment):
      // the margin shifts the centered image up so the whole reserve lands
      // below it — no doubled cap. The lightbox img lives inside the host's
      // `body > *` zoom layer, so the px lengths are LOCAL — the viewport
      // term must be too. The host pre-divides it as
      // --app-scaled-viewport-height (see reset.css); raw 100vh/100dvh
      // double declarations remain as fallbacks for builds without the var
      // (they are exact at scale 1). The var fallback uses the
      // feature-detected unit: an unsupported unit inside var() is invalid at
      // computed-value time and would void the declaration instead of falling
      // back to the earlier ones.
      `img[src="${escaped}"]:not([data-component="MessageContent"] img) { max-block-size: calc(100vh - ${CAPTION_PILL_RESERVE}px); max-block-size: calc(100dvh - ${CAPTION_PILL_RESERVE}px); max-block-size: calc(var(--app-scaled-viewport-height, 100${VIEWPORT_HEIGHT_UNIT}) - ${CAPTION_PILL_RESERVE}px); margin-block-end: ${CAPTION_PILL_RESERVE}px; }`,
    )
  }

  // The one live label, with its tether and dismisser. A new decoration
  // dismisses the previous label unconditionally (unless it is the same
  // lightbox image, in which case the existing label stands) — so no
  // stale or mis-tethered label can ever block subsequent clicks.
  let activeLabel: { img: HTMLImageElement; dismiss: () => void } | null = null

  function hasShutterClass(el: Element): boolean {
    // Token-prefix check, not substring: native CSS-module hashes could
    // coincidentally contain 'sh-'.
    for (const c of Array.from(el.classList)) {
      if (c.startsWith('sh-')) return true
    }
    return false
  }

  function findOpenLightbox(clickedSrc: string, expectedId: string | null): { portalRoot: Element; img: HTMLImageElement } | null {
    // A lightbox render lives in a body-level, fixed full-viewport portal.
    // That lets us find it before the image has finished loading and before
    // it has a large measured rect. The previous version waited for a large,
    // visible image, which meant the metadata lookup could finish first and
    // skip the visible "Reading prompt…" shell entirely.
    function intersectsViewport(rect: DOMRect): boolean {
      return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth
    }
    function looksLikeNativePortal(root: Element): boolean {
      if (root.parentElement !== document.body) return false
      if (hasShutterClass(root)) return false
      const rect = root.getBoundingClientRect()
      if (rect.width < window.innerWidth * 0.5 || rect.height < window.innerHeight * 0.5) return false
      const pos = getComputedStyle(root).position
      return pos === 'fixed' || pos === 'absolute'
    }
    function pick(match: (img: HTMLImageElement) => boolean): { portalRoot: Element; img: HTMLImageElement } | null {
      let best: { portalRoot: Element; img: HTMLImageElement; score: number } | null = null
      for (const img of Array.from(document.images) as HTMLImageElement[]) {
        if (!IMAGE_URL_RE.test(img.src)) continue
        if (!match(img)) continue
        if (img.closest('[data-component="MessageContent"]')) continue
        if (img.closest('.sh-lightbox, .sh-preview')) continue

        let portalRoot: Element = img
        while (portalRoot.parentElement && portalRoot.parentElement !== document.body) {
          portalRoot = portalRoot.parentElement
        }
        if (!looksLikeNativePortal(portalRoot)) continue

        const rect = img.getBoundingClientRect()
        const area = rect.width * rect.height
        const visible = area >= 10000 && intersectsViewport(rect)
        // Prefer the fully laid-out lightbox image, but accept the pre-load
        // <img> too so the loading shell can appear during the native spinner.
        const score = (visible ? 1_000_000_000 : 0) + area
        if (!best || score > best.score) best = { portalRoot, img, score }
      }
      return best ? { portalRoot: best.portalRoot, img: best.img } : null
    }
    const exact = pick(img => img.src === clickedSrc)
    if (exact) return exact
    if (!expectedId) return null
    return pick(img => extractImageId(img.src) === expectedId && !/[?&]size=/.test(img.src))
  }

  function waitMs(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function nextFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()))
  }

  // Resolves once the lightbox image has finished downloading, decoding,
  // and holding a stable layout for a few frames. Mobile WebViews/Safari can
  // report `complete`/`load` while the visible image is still settling into
  // its final painted state, especially with large/progressive images. The
  // metadata fetch waits for this stricter gate so Shutter never competes
  // with the native viewer before the image feels visually done.
  async function waitForLightboxImageSettled(img: HTMLImageElement): Promise<void> {
    if (!(img.complete && img.naturalWidth > 0)) {
      await new Promise<void>((resolve) => {
        let interval: ReturnType<typeof setInterval> | null = null
        const done = () => {
          img.removeEventListener('load', done)
          img.removeEventListener('error', done)
          if (interval !== null) clearInterval(interval)
          resolve()
        }
        img.addEventListener('load', done)
        img.addEventListener('error', done)
        interval = setInterval(() => {
          if ((img.complete && img.naturalWidth > 0) || !img.isConnected) done()
        }, 250)
      })
    }

    if (!img.isConnected) return

    // `decode()` waits for the image to be ready for painting. It can reject
    // for cross-browser edge cases or if the image was detached; rejection is
    // non-fatal because the load/error gate above already did the bandwidth
    // protection work.
    try {
      if (typeof img.decode === 'function') await img.decode()
    } catch {
      // ignore decode failures; continue with frame/geometry settling
    }

    await nextFrame()
    await nextFrame()

    let stableFrames = 0
    let last: { left: number; top: number; width: number; height: number } | null = null
    const started = performance.now()
    const MAX_SETTLE_MS = 700
    while (img.isConnected && performance.now() - started < MAX_SETTLE_MS) {
      const rect = img.getBoundingClientRect()
      const current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      if (current.width > 0 && current.height > 0 && last &&
        Math.abs(current.left - last.left) < 1 &&
        Math.abs(current.top - last.top) < 1 &&
        Math.abs(current.width - last.width) < 1 &&
        Math.abs(current.height - last.height) < 1) {
        stableFrames++
        if (stableFrames >= 3) break
      } else {
        stableFrames = 0
      }
      last = current
      await nextFrame()
    }

    // A tiny paint cushion helps mobile browsers finish compositing the
    // decoded image before the prompt swap/fetch work begins. Keep desktop
    // almost unchanged; use the longer cushion only for coarse pointers.
    const isLikelyMobile = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
    await waitMs(isLikelyMobile ? 180 : 50)
    await nextFrame()
  }

  async function decorateLightbox(portalRoot: Element, img: HTMLImageElement, promptPromise: Promise<PromptSources | null>): Promise<void> {
    if (activeLabel) {
      if (activeLabel.img === img && img.isConnected && document.querySelector('.sh-lightbox-prompt')) return
      activeLabel.dismiss()
    }

    // The pill is injected unconditionally and immediately. An earlier
    // iteration raced promptPromise against a short grace window here so
    // already-settled metadata could skip the loading state — but the byte
    // fetch is gated on the image's visual-settle gate (decode + frame
    // stability + paint cushion), whose floor exceeds any sane grace window,
    // so the race could never be won and only added latency to every open.
    // Settled null (no readable metadata) is handled after the fact: the
    // pill dismisses cleanly via dismissLabel.

    // Reserve the caption strip NOW — the lightbox image is typically still
    // loading (hidden behind native's spinner), so it lays out already sized
    // with room below and is never visibly resized. max-block-size constrains
    // height ALONGSIDE the native class's own max-height (both caps apply;
    // the smaller wins), so native sizing is added to, never replaced.
    let promptExpanded = false
    // Content-aware expanded reserve: measured from the panel's real rendered
    // height (clamped to the adaptive cap) by refreshExpandedReserve, so a
    // four-line prompt barely costs the image anything and only a genuinely
    // long prompt spends the full cap. CAPTION_RESERVE is just the seed.
    let expandedReserve = CAPTION_RESERVE
    const originalMaxBlockSize = img.style.maxBlockSize
    const originalMarginBlockEnd = img.style.marginBlockEnd
    // px term of the inline cap currently applied (subtracted from the scaled
    // viewport). Used to tell whether the measured rect is our own cap
    // echoing back (rect ≈ V − term ⇒ free height unknown, assume bound)
    // versus the image's true free height (cap inert ⇒ rect is authoritative).
    let lastReserveCapTerm: number | null = null
    const applyImageReserve = (expanded = promptExpanded) => {
      if (!img.isConnected) return
      const reserve = expanded ? expandedReserve : CAPTION_PILL_RESERVE
      const localViewportH = window.innerHeight / getUiScale()
      const rectH = img.getBoundingClientRect().height / getUiScale()
      const capBinding = lastReserveCapTerm !== null && rectH >= (localViewportH - lastReserveCapTerm) - 1
      // Centered-fit test: the rect is a LOWER bound on the free height, so
      // it can only prove fitting when no cap of ours is binding. Unloaded
      // images (rect 0) default to bound, matching the click-time stylesheet.
      const centeredFits = rectH > 0 && !capBinding && rectH <= localViewportH - 2 * reserve
      if (centeredFits) {
        // Native centering already leaves a full strip below — no shift, no
        // shrink. The symmetric cap stays on as an inert guarantee in case
        // anything resizes underneath us.
        img.style.maxBlockSize = `calc(var(--app-scaled-viewport-height, 100${VIEWPORT_HEIGHT_UNIT}) - ${reserve * 2}px)`
        img.style.marginBlockEnd = originalMarginBlockEnd
        lastReserveCapTerm = reserve * 2
      } else {
        // Bound (or unknowable): single cap + bottom margin — the image
        // shifts up and keeps its size instead of shrinking about center.
        img.style.maxBlockSize = `calc(var(--app-scaled-viewport-height, 100${VIEWPORT_HEIGHT_UNIT}) - ${reserve}px)`
        img.style.marginBlockEnd = `${reserve}px`
        lastReserveCapTerm = reserve
      }
    }
    applyImageReserve(false)

    // The click-time pre-reserve stylesheet is a module-level singleton; a
    // rapid follow-up click on another image swaps it before this label is
    // dismissed. Snapshot the remover installed for THIS image so teardown
    // never clears a successor's rule.
    const ownedReserveRemover = removeReserveStyle
    const clearOwnedReserveStyle = () => {
      if (ownedReserveRemover && removeReserveStyle === ownedReserveRemover) clearReserveStyle()
    }

    // Releasing the caption reserve has two shapes, matching the two ways a
    // label dies:
    //  - 'now' (prompt hidden via its own ✕, viewer stays open): the strip is
    //    gone, so the image should reclaim the space immediately.
    //  - 'after-close' (the NATIVE VIEWER is closing: backdrop tap, Escape,
    //    route change, portal unmount): the image is about to disappear —
    //    restoring its size first makes it visibly grow for the duration of
    //    the close animation. Leave the cap in place, and release state once
    //    the img actually disconnects. If the close never lands (e.g. Escape
    //    was consumed by a nested dialog), a short grace timeout restores the
    //    size then — at that point the grow-back is correct, the prompt is gone.
    const restoreImageInlineStyles = () => {
      if (!img.isConnected) return
      img.style.maxBlockSize = originalMaxBlockSize
      img.style.marginBlockEnd = originalMarginBlockEnd
    }
    const restoreReserve = (mode: 'now' | 'after-close') => {
      if (mode === 'now') {
        restoreImageInlineStyles()
        clearOwnedReserveStyle()
        return
      }
      const SETTLE_TIMEOUT_MS = 500
      let settled = false
      const finish = (restoreImage: boolean) => {
        if (settled) return
        settled = true
        settleWatcher.disconnect()
        clearTimeout(settleTimer)
        if (restoreImage) restoreImageInlineStyles()
        clearOwnedReserveStyle()
      }
      // subtree: the img can disconnect via an intermediate container, not
      // only via the body-level portal's removal.
      const settleWatcher = new MutationObserver(() => { if (!img.isConnected) finish(false) })
      settleWatcher.observe(document.body, { childList: true, subtree: true })
      const settleTimer = setTimeout(() => finish(img.isConnected), SETTLE_TIMEOUT_MS)
      if (!img.isConnected) finish(false)
    }

    // NOTE: an earlier iteration force-elevated the native portal's z-index
    // (to 2147483645, with isolation) while the prompt was open, to stop the
    // background chat layer from momentarily painting over the lightbox
    // during nested scroll gestures. The boundary wheel/touch containment on
    // the scroll region below addresses the CAUSE of that artifact — scroll
    // gestures can no longer chain into the chat, so its layer never repaints
    // mid-gesture — and the elevation buried host toasts behind the portal
    // for the prompt's lifetime. If the paint-over artifact ever reappears,
    // re-adding the elevation here is the known workaround.

    // Shared markup for the resolved label — used both by the fast path
    // (metadata settled before decoration) and the shell's in-place swap.
    // Function declaration so it hoists above the injection below. Builds
    // only the swappable body — the heading and its stable action buttons
    // live OUTSIDE .sh-lightbox-prompt-content so their listeners survive
    // the shell → prompt swap without any destroy/remount or rewiring.
    function bodyContentHtml(view: PromptMetadataView, sources: PromptSources): string {
      const selector = sources.shutter && sources.embedded
        ? `<div class="sh-lightbox-prompt-source-row">
            <div class="sh-prompt-source-tabs" role="tablist" aria-label="Prompt metadata source">
              <button type="button" class="sh-prompt-source-btn${view.source === 'shutter' ? ' sh-active' : ''}" data-source="shutter" role="tab" aria-selected="${view.source === 'shutter'}">Shutter</button>
              <button type="button" class="sh-prompt-source-btn${view.source === 'embedded' ? ' sh-active' : ''}" data-source="embedded" role="tab" aria-selected="${view.source === 'embedded'}">Embedded</button>
            </div>
          </div>`
        : ''
      const details = formatPromptMetadataLine(view)
      const negativeBlock = view.negativePrompt
        ? `<div class="sh-lightbox-prompt-heading">Negative Prompt</div><div class="sh-lightbox-prompt-text">${escapeHtml(view.negativePrompt)}</div>`
        : ''
      return `${selector}<div class="sh-prompt-source-meta">${escapeHtml(details)}</div><div class="sh-lightbox-prompt-text">${escapeHtml(view.prompt)}</div>${negativeBlock}`
    }

    // Inject a stable shell immediately — or, when metadata already settled,
    // the finished label directly. The shell avoids the jarring delayed box
    // pop-in while metadata is fetched/parsing, without blocking the native
    // lightbox image or storing any prompt data. The Close action uses the
    // same compact button treatment as the rest of Shutter's lightbox row;
    // the loading indicator remains Lumiverse's shared spinner.
    //
    // BODY-LEVEL ON PURPOSE — do not move this back inside the portal. In
    // glass mode the native backdrop carries backdrop-filter: blur(), and in
    // Chromium ANY painting inside a backdrop-filtered subtree (scrolling
    // this label, its scrollbar, opacity transitions) forces the filter
    // surface to re-capture — which intermittently drops the blur for a
    // frame, flashing the unblurred chat through. Injecting the label as a
    // body-level sibling of the portal keeps its painting out of the filter
    // surface entirely. app_manipulation covers body-level portals, and the
    // label is position:fixed, so geometry is unaffected.
    const wrapper = ctx.dom.inject(document.body, `
      <div class="sh-lightbox-prompt sh-pill sh-loading" aria-live="polite">
        <div class="sh-lightbox-prompt-heading">
          <span class="sh-lightbox-prompt-status"><span class="sh-lightbox-prompt-spinner-slot" aria-hidden="true"></span><span>Reading prompt…</span></span>
          <span class="sh-lightbox-prompt-actions">
            <button class="sh-lightbox-prompt-history" type="button" title="View generation history" aria-label="View generation history" hidden disabled>History</button>
            <button class="sh-lightbox-prompt-view" type="button" title="View prompt" aria-label="View prompt" hidden disabled>Prompt</button>
            <button class="sh-lightbox-prompt-collapse" type="button" title="Collapse prompt" aria-label="Collapse prompt" hidden disabled>Collapse</button>
            <button class="sh-lightbox-prompt-copy" type="button" title="Copy prompt" aria-label="Copy prompt" hidden disabled>Copy</button>
            <button class="sh-lightbox-prompt-close" type="button" title="Close prompt controls" aria-label="Close prompt controls">Close</button>
          </span>
        </div>
        <div class="sh-lightbox-prompt-scroll" hidden>
          <div class="sh-lightbox-prompt-content"></div>
        </div>
      </div>
    `, 'beforeend')

    // Placement is measured, not laid out: the label is fixed-positioned to
    // the lightbox image's bounding rect — directly below it, at its width —
    // so it is independent of how any host build structures the portal. A
    // periodic tick re-measures (covering image load, zoom, and window
    // changes) and doubles as the lifecycle tether: some host builds mount
    // the lightbox inside a persistent overlay container, so DOM ancestry
    // can't be trusted for lifetime — but the lightbox <img> disconnecting
    // is definitive. If the gap under the image is too small for a minimum
    // caption strip, the image's max-height is shaved just enough to create
    // one, and restored on dismiss.
    const ws = (wrapper as HTMLElement).style
    ws.position = 'fixed'
    // Same z-index as the native backdrop (10003): as a LATER body sibling
    // the label paints above the backdrop by document order, while host
    // layers at 10004+ (menus, dialogs, toasts) still cover it.
    ws.zIndex = '10003'
    let labelEl = wrapper.querySelector('.sh-lightbox-prompt') as HTMLElement | null

    // Body-level injection means the portal's unmount no longer removes the
    // wrapper for us, and the lifecycle tick is a slow 1s fallback — without
    // this, a dismissed lightbox would leave the label floating over the
    // chat for up to a second. Watching body childList catches the portal's
    // removal the moment it happens.
    const portalWatcher = new MutationObserver(() => {
      if (!portalRoot.isConnected || !img.isConnected) {
        dismissLabel()
        return
      }
      // The label paints above the backdrop purely by DOCUMENT ORDER (same
      // z-index, later body sibling). If the host re-appends/remounts the
      // portal after us — menus, confirm dialogs, and React remounts can —
      // that invariant silently flips and the backdrop buries the pill.
      // Moving the wrapper back to the end restores it: a move preserves
      // listeners, inline styles, and the host-mounted close button/spinner,
      // and only fires when order is actually wrong, so the mutation this
      // move itself triggers can't loop.
      if (wrapper.isConnected && (wrapper.compareDocumentPosition(portalRoot) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        document.body.appendChild(wrapper)
      }
    })
    portalWatcher.observe(document.body, { childList: true })
    
    function setStyleIfChanged(style: CSSStyleDeclaration, prop: string, value: string): void {
      if (style.getPropertyValue(prop) !== value) {
        style.setProperty(prop, value)
      }
    }
    
    const GAP = CAPTION_GAP
    const EDGE = CAPTION_EDGE
    const MIN_LOADING_MS = 220
    const shellShownAt = performance.now()

    const cleanupFns: Array<() => void> = []
    cleanupFns.push(() => portalWatcher.disconnect())
    let dismissed = false
    let promptSources: PromptSources | null = null
    let resolvedPrompt: PromptMetadataView | null = null
    const promptEl = labelEl
    const scrollEl = wrapper.querySelector('.sh-lightbox-prompt-scroll') as HTMLElement | null
    const contentEl = wrapper.querySelector('.sh-lightbox-prompt-content') as HTMLElement | null
    const statusEl = wrapper.querySelector('.sh-lightbox-prompt-status') as HTMLElement | null
    const historyBtn = wrapper.querySelector('.sh-lightbox-prompt-history') as HTMLButtonElement | null
    const viewBtn = wrapper.querySelector('.sh-lightbox-prompt-view') as HTMLButtonElement | null
    const collapseBtn = wrapper.querySelector('.sh-lightbox-prompt-collapse') as HTMLButtonElement | null
    let suppressPositionUntil = 0
    const suppressPositionBriefly = () => {
      suppressPositionUntil = performance.now() + 180
    }

    // 'closing' is the default on purpose: every dismissal except the pill's
    // own ✕ is a teardown where the native viewer is going (or already gone)
    // away, and eagerly restoring the image size there is exactly the
    // grow-then-vanish flash. restoreReserve('after-close') handles the "the
    // close never actually landed" edge with its grace timeout.
    function dismissLabel(reason: 'hide' | 'closing' = 'closing'): void {
      if (dismissed) return
      dismissed = true
      if (activeLabel && activeLabel.dismiss === dismissLabel) activeLabel = null
      for (const fn of cleanupFns) fn()
      restoreReserve(reason === 'hide' ? 'now' : 'after-close')
      ctx.dom.uninject(wrapper)
    }
    activeLabel = { img, dismiss: dismissLabel }

    // Body-level injection means the prompt no longer disappears just
    // because the native portal starts its close animation. On mobile that
    // can leave the prompt visually trailing the viewer by a beat, so remove
    // it on the same user action that is likely to close the native viewer
    // instead of waiting for the DOM-removal watcher or lifecycle tether.
    const dismissOnNativeCloseInteraction = (event: Event): void => {
      if (dismissed) return
      const target = event.target as Node | null
      if (!target) return
      if (wrapper.contains(target)) return
      if (!portalRoot.isConnected || !img.isConnected) {
        dismissLabel()
        return
      }
      if (!portalRoot.contains(target)) return

      const targetEl = target instanceof Element ? target : target.parentElement
      if (!targetEl) return
      // Tapping the image itself should keep the prompt.
      const touchedImage = targetEl.closest?.('img') as HTMLImageElement | null
      if (touchedImage && touchedImage === img) return
      // Only a tap on the backdrop itself closes the native viewer — and the
      // backdrop is recognizable as the element that CONTAINS the image (it
      // is the flex container centering it). Menu items and confirm-dialog
      // buttons live inside the portal but are NOT ancestors of the image,
      // so interacting with them no longer dismisses the prompt. Closes
      // triggered from inside those layers (e.g. delete → confirm) are
      // caught by the Escape/route listeners and the portal state watcher.
      if (!targetEl.contains(img)) return
      dismissLabel()
    }

    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismissLabel()
    }
    const dismissOnRouteClose = (): void => dismissLabel()

    document.addEventListener('pointerdown', dismissOnNativeCloseInteraction, true)
    document.addEventListener('touchstart', dismissOnNativeCloseInteraction, true)
    document.addEventListener('mousedown', dismissOnNativeCloseInteraction, true)
    document.addEventListener('click', dismissOnNativeCloseInteraction, true)
    document.addEventListener('keydown', dismissOnEscape, true)
    window.addEventListener('popstate', dismissOnRouteClose)
    window.addEventListener('hashchange', dismissOnRouteClose)
    cleanupFns.push(() => {
      document.removeEventListener('pointerdown', dismissOnNativeCloseInteraction, true)
      document.removeEventListener('touchstart', dismissOnNativeCloseInteraction, true)
      document.removeEventListener('mousedown', dismissOnNativeCloseInteraction, true)
      document.removeEventListener('click', dismissOnNativeCloseInteraction, true)
      document.removeEventListener('keydown', dismissOnEscape, true)
      window.removeEventListener('popstate', dismissOnRouteClose)
      window.removeEventListener('hashchange', dismissOnRouteClose)
    })

    const portalStateWatcher = new MutationObserver(() => {
      requestAnimationFrame(() => {
        if (dismissed) return
        if (!portalRoot.isConnected || !img.isConnected) {
          dismissLabel()
          return
        }
        if (portalRoot instanceof HTMLElement) {
          const computed = getComputedStyle(portalRoot)
          if (computed.display === 'none' || computed.visibility === 'hidden' || Number(computed.opacity) <= 0.01) {
            dismissLabel()
          }
        }
      })
    })
    portalStateWatcher.observe(portalRoot, { attributes: true, attributeFilter: ['class', 'style', 'aria-hidden', 'data-state'] })
    cleanupFns.push(() => portalStateWatcher.disconnect())

    // Pure placement: the caption strip was reserved before the image became
    // visible, so this never writes to the image. It keeps the label glued to
    // the image's measured rect while sizing it with an image-aware desktop
    // width and a stable mobile width.
    function positionLabel(): void {
      if (!img.isConnected || !wrapper.isConnected) {
        dismissLabel()
        return
      }
      if (performance.now() < suppressPositionUntil) return
      const rect = img.getBoundingClientRect()
      // gBCR and window.innerWidth report VISUAL pixels, but every px we
      // write below is interpreted inside the host's `body > *` zoom layer
      // (LOCAL pixels, multiplied by --lumiverse-ui-scale on render). Convert
      // the measurements once; the PROMPT_*/PILL_* constants are already
      // local px matching the stylesheet, so the rest of the math needs no
      // per-site adjustment. At scale 1 this is a no-op.
      const uiScale = getUiScale()
      const rectLeft = rect.left / uiScale
      const rectBottom = rect.bottom / uiScale
      const rectWidth = rect.width / uiScale
      const rectHeight = rect.height / uiScale
      const viewportWidthLocal = window.innerWidth / uiScale
      const isExpanded = labelEl?.classList.contains('sh-expanded') ?? promptExpanded
      const promptMaxHeight = isExpanded ? getPromptMaxHeight(rectHeight > 0 ? rectHeight : undefined) : PROMPT_PILL_HEIGHT
      const isCompact = isCompactPromptLayout()
      const viewportMax = viewportWidthLocal - EDGE * 2
      const expandedWidth = rect.width === 0 || rect.height === 0
        ? (isCompact
            ? Math.min(PROMPT_MOBILE_MAX_WIDTH, viewportMax)
            : Math.min(PROMPT_DESKTOP_MIN_WIDTH, viewportMax))
        : (isCompact
            ? Math.min(rectWidth, PROMPT_MOBILE_MAX_WIDTH, viewportMax)
            : Math.min(
                Math.max(rectWidth, PROMPT_DESKTOP_MIN_WIDTH),
                PROMPT_DESKTOP_MAX_WIDTH,
                viewportMax,
              ))

      // Restore the stable 1.0.6 collapsed width so different action
      // combinations and the temporary Copied state never resize the bar.
      // Expanded prompt sizing remains image-aware.
      const collapsedWidth = Math.min(
        isCompact ? PROMPT_PILL_MOBILE_WIDTH : PROMPT_PILL_DESKTOP_WIDTH,
        viewportMax,
      )
      const toolbarWidth = isExpanded ? expandedWidth : collapsedWidth
      setStyleIfChanged(ws, 'width', `${toolbarWidth}px`)
      setStyleIfChanged(ws, 'min-width', '0px')
      setStyleIfChanged(ws, 'max-width', `${viewportMax}px`)

      if (rect.width === 0 || rect.height === 0) {
        // Native lightbox mounts the <img> before it has natural dimensions.
        // Keep the loading shell visible near the spinner until the image has
        // a real rect, then snap it under the image.
        setStyleIfChanged(ws, 'top', 'calc(50% + 48px)')
        setStyleIfChanged(ws, 'left', '50%')
        setStyleIfChanged(ws, 'transform', 'translateX(-50%)')

        if (labelEl) {
          setStyleIfChanged(labelEl.style, 'max-height', `${promptMaxHeight}px`)
        }
        return
      }

      const measuredWidth = toolbarWidth
      const left = Math.max(EDGE, Math.min(rectLeft + (rectWidth - measuredWidth) / 2, viewportWidthLocal - measuredWidth - EDGE))

      setStyleIfChanged(ws, 'top', `${rectBottom + GAP}px`)
      setStyleIfChanged(ws, 'left', `${left}px`)
      setStyleIfChanged(ws, 'transform', '')

      if (labelEl) {
        setStyleIfChanged(labelEl.style, 'max-height', `${promptMaxHeight}px`)
      }
    }

    // Coalesce all triggers into one measurement per frame.
    let rafId = 0
    function schedulePosition(): void {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        positionLabel()
      })
    }
    cleanupFns.push(() => { if (rafId) cancelAnimationFrame(rafId) })

    // Frame-accurate tracking of the image's rect (load, native responsive
    // sizing, the CSS cap responding to window resizes). The slow tick is
    // purely the lifecycle tether for host builds with persistent overlay
    // containers.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(schedulePosition)
      ro.observe(img)
      cleanupFns.push(() => ro.disconnect())
    }
    const lifecycleTick = setInterval(() => {
      if (!img.isConnected || !wrapper.isConnected) dismissLabel()
      else schedulePosition()
    }, 1000)
    cleanupFns.push(() => clearInterval(lifecycleTick))
    // Resize changes the adaptive expanded cap (viewport-fraction) and moves
    // the hybrid centered/bound boundary — re-measure and re-apply the image
    // reserve in BOTH states before the scheduled reposition reads the image
    // rect. refreshExpandedReserve is hoisted (declared below).
    const onWindowResize = (): void => {
      if (promptExpanded) refreshExpandedReserve()
      applyImageReserve()
      schedulePosition()
    }
    window.addEventListener('resize', onWindowResize)
    cleanupFns.push(() => window.removeEventListener('resize', onWindowResize))
    // The hybrid mode decision needs real dimensions: before load the rect is
    // 0 and the reserve defaults to bound (margin model, matching the
    // click-time stylesheet). Re-decide the moment dimensions exist — the
    // native viewer keeps the img at opacity 0 until load, so a correction
    // here lands before the reveal.
    const onImgLoad = () => {
      applyImageReserve()
      schedulePosition()
    }
    img.addEventListener('load', onImgLoad)
    cleanupFns.push(() => img.removeEventListener('load', onImgLoad))
    positionLabel()

    // The lightbox closes on backdrop click; interactions with the label
    // (selecting/copying text, scrolling) must not bubble into that handler.
    // Wheel/touchmove are non-passive so boundary gestures are consumed
    // instead of scroll-chaining into the background virtualized chat, which
    // can provoke Chrome to repaint that chat layer over the lightbox.
    const stopLabelEvent = (event: Event) => event.stopPropagation()
    for (const eventName of ['click', 'pointerdown', 'mousedown', 'touchstart']) {
      wrapper.addEventListener(eventName, stopLabelEvent, { passive: true })
    }
    // Event (not WheelEvent/TouchEvent): `wrapper` is typed Element, whose
    // addEventListener overloads reject narrower handler signatures — and
    // stopPropagation is all these need.
    wrapper.addEventListener('wheel', stopLabelEvent, { passive: false })
    wrapper.addEventListener('touchmove', stopLabelEvent, { passive: false })

    if (scrollEl) {
      let lastTouchY: number | null = null
      const consumeBoundaryWheel = (event: WheelEvent) => {
        suppressPositionBriefly()
        event.stopPropagation()
        const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight
        if (maxScrollTop <= 0) {
          event.preventDefault()
          return
        }
        const atTop = scrollEl.scrollTop <= 0
        const atBottom = scrollEl.scrollTop >= maxScrollTop - 1
        if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
          event.preventDefault()
        }
      }
      const rememberTouchY = (event: TouchEvent) => {
        stopLabelEvent(event)
        lastTouchY = event.touches[0]?.clientY ?? null
      }
      const consumeBoundaryTouchMove = (event: TouchEvent) => {
        suppressPositionBriefly()
        event.stopPropagation()
        const y = event.touches[0]?.clientY ?? null
        if (y === null || lastTouchY === null) {
          lastTouchY = y
          return
        }
        const deltaY = lastTouchY - y
        lastTouchY = y
        const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight
        if (maxScrollTop <= 0) {
          event.preventDefault()
          return
        }
        const atTop = scrollEl.scrollTop <= 0
        const atBottom = scrollEl.scrollTop >= maxScrollTop - 1
        if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
          event.preventDefault()
        }
      }

      scrollEl.addEventListener('scroll', suppressPositionBriefly, { passive: true })
      scrollEl.addEventListener('wheel', consumeBoundaryWheel, { passive: false })
      scrollEl.addEventListener('touchstart', rememberTouchY, { passive: true })
      scrollEl.addEventListener('touchmove', consumeBoundaryTouchMove, { passive: false })
      scrollEl.addEventListener('touchend', () => { lastTouchY = null }, { passive: true })
      scrollEl.addEventListener('touchcancel', () => { lastTouchY = null }, { passive: true })
    }
    // Measure what the expanded panel ACTUALLY uses and reserve exactly that.
    // Requires the expanded classes and content to be in the DOM already, so
    // call sites toggle state first, refresh second, applyImageReserve third.
    // Function declaration on purpose: the resize handler above registers
    // before this point in source order and relies on hoisting.
    function refreshExpandedReserve(): void {
      if (!promptEl) return
      // Size the cap against the image itself (see getPromptMaxHeight). For
      // height-bound images the pill-state height feeds the min() but the
      // solved bound-case term wins, so pre- vs post-shrink measurement
      // yields the same cap — no oscillation.
      const imgLocalH = img.isConnected ? img.getBoundingClientRect().height / getUiScale() : 0
      const maxH = getPromptMaxHeight(imgLocalH > 0 ? imgLocalH : undefined)
      setStyleIfChanged(promptEl.style, 'max-height', `${maxH}px`)
      // offsetHeight is border-box (host resets to border-box globally), so
      // this is the panel's full rendered height, already clamped by maxH.
      expandedReserve = Math.min(promptEl.offsetHeight, maxH) + CAPTION_GAP + CAPTION_EDGE
    }

    function renderPromptSource(view: PromptMetadataView): void {
      if (!contentEl || !promptSources) return
      resolvedPrompt = view
      contentEl.innerHTML = bodyContentHtml(view, promptSources)
      contentEl.querySelectorAll<HTMLButtonElement>('.sh-prompt-source-btn').forEach(button => {
        button.addEventListener('click', () => {
          const next = button.dataset.source === 'embedded'
            ? promptSources?.embedded
            : promptSources?.shutter
          if (!next || next.source === resolvedPrompt?.source) return
          renderPromptSource(next)
          if (scrollEl) scrollEl.scrollTop = 0
          if (promptExpanded) {
            refreshExpandedReserve()
            applyImageReserve(true)
            suppressPositionUntil = 0
            positionLabel()
          }
        })
      })
    }

    const openHistoryFromToolbar = () => {
      if (!promptSources || promptSources.history.length === 0 || !promptSources.imageId) return

      // The history viewer is a Spindle modal layered above Lumiverse's
      // native image lightbox. Insert/Replace should commit the selected
      // image and then close that exact underlying viewer as one action.
      // Capture this portal/image pair so a delayed close can never affect
      // a different lightbox opened afterwards.
      const closeUnderlyingLightbox = () => {
        if (!portalRoot.isConnected || !img.isConnected) return
        dismissLabel()
        setTimeout(() => {
          if (!portalRoot.isConnected || !img.isConnected) return
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
            cancelable: true,
          }))
        }, 0)
      }

      deps.openHistory(promptSources.history, promptSources.imageId, closeUnderlyingLightbox)
    }

    historyBtn?.addEventListener('click', openHistoryFromToolbar)

    function setPromptExpanded(expanded: boolean): void {
      if (!promptEl || !contentEl || !scrollEl || !resolvedPrompt) return
      promptExpanded = expanded
      promptEl.classList.toggle('sh-pill', !expanded)
      promptEl.classList.toggle('sh-expanded', expanded)
      scrollEl.hidden = !expanded
      if (statusEl) statusEl.hidden = true
      if (viewBtn) {
        viewBtn.hidden = expanded
        viewBtn.disabled = expanded
      }
      if (collapseBtn) {
        collapseBtn.hidden = !expanded
        collapseBtn.disabled = !expanded
      }
      if (expanded) refreshExpandedReserve()
      applyImageReserve(expanded)
      // Synchronous, not scheduled: the class toggles above and the image's
      // new reserve just changed layout in THIS frame — waiting a rAF leaves
      // one visible frame of expanded content clipped inside 44px pill
      // geometry (and the image jumping a frame ahead of the panel).
      // positionLabel's gBCR forces layout, so it reads the post-reserve
      // rect. Scroll suppression is cleared first: a touch-scroll followed
      // within 180ms by a Collapse tap must still reposition.
      suppressPositionUntil = 0
      positionLabel()
    }

    viewBtn?.addEventListener('click', () => setPromptExpanded(true))
    collapseBtn?.addEventListener('click', () => setPromptExpanded(false))

    // Heading chrome is stable across the shell → prompt swap (only
    // .sh-lightbox-prompt-content is replaced), so the action listeners are
    // wired exactly once and remain intact for the label's full lifetime.
    const copyBtn = wrapper.querySelector('.sh-lightbox-prompt-copy') as HTMLButtonElement | null
    copyBtn?.addEventListener('click', () => {
      if (!copyBtn || !resolvedPrompt) return
      const text = formatPromptMetadataForClipboard(resolvedPrompt)
      // Mirrors native's code-copy confirmation: label swap + success color
      // for 2000ms, with a checkmark inheriting the success color.
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

    // The one 'hide' dismissal: the native image viewer stays open, so the
    // image should reclaim the caption space immediately.
    const closeBtn = wrapper.querySelector('.sh-lightbox-prompt-close') as HTMLButtonElement | null
    closeBtn?.addEventListener('click', () => dismissLabel('hide'))

    // Spinner lives inside the swappable content region, so it is destroyed
    // explicitly before the swap replaces its DOM (and via cleanup if the
    // label is dismissed while still loading). Nullable guard keeps the two
    // destruction paths from double-destroying.
    const spinnerSlot = wrapper.querySelector('.sh-lightbox-prompt-spinner-slot')
    let spinnerHandle: { destroy(): void } | null = spinnerSlot
      ? ctx.components.mountSpinner(spinnerSlot, { size: 12, fast: true })
      : null
    const destroySpinner = () => {
      spinnerHandle?.destroy()
      spinnerHandle = null
    }
    cleanupFns.push(destroySpinner)

    // Resolution was kicked off at click time, in parallel with the lightbox
    // opening. The already-mounted shell is updated in place when metadata
    // arrives; if no readable metadata exists, it is removed cleanly.
    const resolved = await promptPromise
    const loadingElapsed = performance.now() - shellShownAt
    if (loadingElapsed < MIN_LOADING_MS) {
      await new Promise(resolve => setTimeout(resolve, MIN_LOADING_MS - loadingElapsed))
    }
    if (dismissed) return
    if (!portalRoot.isConnected || !img.isConnected || !wrapper.isConnected) {
      dismissLabel()
      return
    }
    if (!resolved || (!resolved.shutter && !resolved.embedded)) {
      // No saved or readable embedded metadata but the viewer is still open:
      // the pill leaves quietly and the image reclaims the strip immediately.
      dismissLabel('hide')
      return
    }
    promptSources = resolved
    resolvedPrompt = resolved.shutter ?? resolved.embedded

    if (!promptEl || !contentEl || !scrollEl || !resolvedPrompt) {
      dismissLabel()
      return
    }
    promptEl.classList.add('sh-swapping')
    await new Promise(resolve => setTimeout(resolve, 120))
    if (dismissed || !promptEl.isConnected) return
    destroySpinner()
    promptEl.classList.remove('sh-loading')
    promptEl.classList.add('sh-ready', 'sh-pill')
    promptEl.classList.remove('sh-expanded')
    renderPromptSource(resolvedPrompt)
    scrollEl.hidden = true
    if (statusEl) statusEl.hidden = true
    if (historyBtn) {
      historyBtn.hidden = resolved.history.length === 0
      historyBtn.disabled = resolved.history.length === 0
      historyBtn.textContent = resolved.history.length > 0
        ? `History · ${resolved.history.length}`
        : 'History'
    }
    if (viewBtn) {
      viewBtn.hidden = false
      viewBtn.disabled = false
    }
    if (collapseBtn) {
      collapseBtn.hidden = true
      collapseBtn.disabled = true
    }
    if (copyBtn) {
      copyBtn.hidden = false
      copyBtn.disabled = false
    }
    promptExpanded = false
    applyImageReserve(false)
    promptEl.classList.remove('sh-swapping')
    labelEl = promptEl
    schedulePosition()
  }

  function onDocumentClick(e: Event): void {
    if (!lightboxWatcherActive) return
    const target = e.target as Element | null
    const img = target?.closest?.('img[alt="shutter"]') as HTMLImageElement | null
    if (!img) return
    if (img.closest('.sh-lightbox, .sh-preview')) return

    // Resolve the authoritative tag from the message markdown, in parallel
    // with the lightbox opening. The clicked image's position among the
    // message's Shutter images maps it to the matching markdown tag.
    const messageId = ctx.dom.getMessageId(img)
    const chatId = ctx.getActiveChat()?.chatId
    let index = 0
    if (messageId) {
      const bubble = ctx.dom.findMessageElement(messageId)
      if (bubble) {
        const siblings = Array.from(bubble.querySelectorAll('img[alt="shutter"]'))
        const found = siblings.indexOf(img)
        if (found >= 0) index = found
      }
    }
    const clickedId = extractImageId(img.src)
    applyReserveStyle(img.src)
    const tagPromise = (messageId && chatId)
      ? comms.resolveShutterTag(chatId, messageId, index)
      : Promise.resolve(null)
    // Start the small userStorage lookup immediately. Embedded metadata still
    // waits for the native image to settle so it cannot compete with the
    // lightbox's image download on constrained mobile connections.
    const recordPromise = tagPromise.then(tag => {
      const imageId = tag?.imageId ?? clickedId
      return imageId && chatId ? comms.getGenerationRecord(chatId, imageId) : Promise.resolve(null)
    })
    const historyPromise = recordPromise.then(record =>
      record ? comms.getGenerationHistory(record.target) : Promise.resolve([] as GenerationHistoryRecord[])
    )
    // The tag round-trip starts NOW (Spindle message channel — no HTTP
    // contention), but the metadata BYTE fetch is gated on the lightbox
    // image finishing download/decode/visual settling: both requests pull
    // large originals over the same connection pool, and racing them can
    // visibly stall the native image on slow links. The loading shell covers
    // the gate.
    const clickedSrc = img.src

    let attempts = 0
    let located = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let mountWatcher: MutationObserver | null = null
    const stopLooking = () => {
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = null
      mountWatcher?.disconnect()
      mountWatcher = null
    }
    const tryLocate = (): boolean => {
      if (located) return true
      const found = findOpenLightbox(clickedSrc, clickedId)
      if (!found) return false
      located = true
      stopLooking()
      const promptPromise = Promise.all([tagPromise, waitForLightboxImageSettled(found.img)])
        .then(async ([tag]) => {
          const [record, history, embedded] = await Promise.all([
            recordPromise,
            historyPromise,
            resolveEmbeddedPromptForImage(tag, clickedSrc),
          ])
          const sources: PromptSources = {
            shutter: record ? promptViewFromRecord(record) : null,
            embedded: embedded
              ? promptViewFromEmbedded(embedded.prompt, embedded.negativePrompt)
              : null,
            history,
            imageId: tag?.imageId ?? clickedId ?? '',
          }
          return sources.shutter || sources.embedded ? sources : null
        })
      void decorateLightbox(found.portalRoot, found.img, promptPromise)
      return true
    }
    // Mount-driven discovery: the native portal is a direct body child, so a
    // body childList observer catches it the frame it mounts — the pill no
    // longer waits out the remainder of a 250ms polling slot when the portal
    // appears just after a tick. The interval remains as a fallback (e.g. a
    // host build mounting the <img> a beat after the portal) and still owns
    // the ~2.5s give-up.
    const tick = () => {
      attempts++
      if (tryLocate()) return
      if (attempts < 10) retryTimer = setTimeout(tick, 250)
      else {
        stopLooking()
        clearReserveStyle()
      }
    }
    mountWatcher = new MutationObserver(() => { tryLocate() })
    mountWatcher.observe(document.body, { childList: true })
    requestAnimationFrame(() => requestAnimationFrame(tick))
  }

  function syncLightboxObserver(): void {
    const shouldRun = Boolean(deps.getSettings()?.showPromptInLightbox) && deps.hasPermission('app_manipulation')
    if (shouldRun && !lightboxWatcherActive) {
      document.addEventListener('click', onDocumentClick, true)
      lightboxWatcherActive = true
    } else if (!shouldRun && lightboxWatcherActive) {
      document.removeEventListener('click', onDocumentClick, true)
      lightboxWatcherActive = false
      activeLabel?.dismiss()
      clearReserveStyle()
    }
  }


  // Entry cleanup: identical teardown to the pre-split cleanup fragment.
  function dispose(): void {
    document.removeEventListener('click', onDocumentClick, true)
    lightboxWatcherActive = false
    activeLabel?.dismiss()
    clearReserveStyle()
  }

  return {
    sync: syncLightboxObserver,
    onHistoryCleared: () => activeLabel?.dismiss(),
    dispose,
  }
}
