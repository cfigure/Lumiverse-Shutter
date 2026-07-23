// Shutter's static stylesheet and shared presentation constants.
// The CSS string is fully static (no interpolation); the entry file
// installs it once via ctx.dom.addStyle(SHUTTER_CSS). The dynamic inline
// image-layout rules (user-configurable width/alignment) are NOT here —
// they are built per-settings in frontend.ts (syncShutterImageLayoutStyle).
//
// ── Styles ──
//
// Settings selects use native <select> matching SettingsModal.module.css
// Modal textareas and buttons match InputPromptModal.module.css
// Image preview matches ImageGenPanel.module.css
// Lightbox matches ImageLightbox.module.css

export const SHUTTER_CSS = `
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
    .sh-settings-divider { border-top: 1px solid var(--lumiverse-border); margin: 10px 0 8px; }
    .sh-settings-note { font-size: calc(11.5px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-muted); line-height: 1.45; margin: 0 0 6px; }
    .sh-auto-section { margin-top: 10px; }
    .sh-range-row { display: flex; align-items: center; gap: 6px; }
    .sh-range-label { font-size: calc(12px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-muted); }
    .sh-percent-control { display: inline-flex; align-items: center; gap: 6px; }
    .sh-percent-input { width: 76px; text-align: right; }
    .sh-percent-suffix { font-size: calc(12px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-muted); }

    /* Native <select> — matches SettingsModal.module.css */
    .sh-select { padding: 6px 10px; border-radius: 8px; background: var(--lumiverse-fill-subtle); border: 1px solid var(--lumiverse-border); color: var(--lumiverse-text); font-size: calc(13px * var(--lumiverse-font-scale, 1)); font-family: inherit; outline: none; cursor: pointer; }
    .sh-select:focus { border-color: var(--lumiverse-primary); }

    /* ── Destination modal ── */
    /* padding 0 is correct: the host modal content area already supplies the
   native 16px padding and 8px gap (SpindleUIManager). Adding more here
   overflows the 520px height cap and brings back the scrollbar. */
    .sh-modal-body { padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .sh-replace-row { padding: 2px 0; }

    /* Image preview — matches ImageGenPanel.module.css */
    .sh-preview { position: relative; border: 1px solid var(--lumiverse-border); border-radius: 10px; overflow: hidden; cursor: zoom-in; background: var(--lumiverse-bg-elevated); }
    .sh-preview img { display: block; width: 100%; max-height: min(34vh, 340px); object-fit: contain; }

    /* ── Generation history nav (destination modal) ── */
    .sh-histnav { position: absolute; top: 50%; transform: translateY(-50%); width: 32px; height: 48px; display: flex; align-items: center; justify-content: center; border: none; border-radius: 8px; background: rgba(0, 0, 0, 0.45); color: #fff; font-size: 22px; line-height: 1; cursor: pointer; opacity: 0.85; z-index: 2; user-select: none; }
    .sh-histnav:hover:not(:disabled) { opacity: 1; background: rgba(0, 0, 0, 0.65); }
    .sh-histnav:disabled { opacity: 0.25; cursor: default; }
    .sh-histnav-prev { left: 8px; }
    .sh-histnav-next { right: 8px; }
    .sh-histcount { position: absolute; bottom: 8px; right: 8px; padding: 2px 8px; border-radius: 999px; background: rgba(0, 0, 0, 0.55); color: #fff; font-size: calc(11px * var(--lumiverse-font-scale, 1)); z-index: 2; pointer-events: none; }

    /* ── Lightbox — matches ImageLightbox.module.css ── */
    .sh-lightbox { position: fixed; inset: 0; width: var(--app-scaled-viewport-width, 100vw); height: var(--app-scaled-viewport-height, 100vh); z-index: 10003; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--lumiverse-modal-backdrop, rgba(0,0,0,0.8)); cursor: pointer; }
    [data-glass] .sh-lightbox { backdrop-filter: blur(var(--lcs-glass-soft-blur, 6px)); }
    .sh-lightbox img { max-width: 90vw; max-height: 90vh; object-fit: contain; border-radius: var(--lcs-radius-sm, 8px); cursor: default; }

    /* ── Prompt preview modal — matches InputPromptModal.module.css ── */
    .sh-prompt-subtitle { font-size: calc(12px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-muted); margin: 0; padding: 0; line-height: 1.5; }
    .sh-prompt-body { padding: 0; display: flex; flex-direction: column; gap: 14px; }
    .sh-prompt-field { display: flex; flex-direction: column; gap: 6px; }
    .sh-prompt-label { font-size: calc(11px * var(--lumiverse-font-scale, 1)); font-weight: 600; color: var(--lumiverse-text-muted); text-transform: uppercase; letter-spacing: 0.5px; }

    /* Textareas — matches InputPromptModal.module.css .textarea */
    .sh-prompt-textarea { width: 100%; min-height: 120px; max-height: 280px; padding: 12px 14px; border-radius: var(--lcs-radius-sm, 8px); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-bg-dark); color: var(--lumiverse-text); font-size: calc(13px * var(--lumiverse-font-scale, 1)); line-height: 1.5; resize: vertical; font-family: inherit; transition: border-color var(--lumiverse-transition-fast); box-sizing: border-box; }
    .sh-prompt-textarea::placeholder { color: var(--lumiverse-text-dim); }
    .sh-prompt-textarea:focus { outline: none; border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5)); }
    .sh-prompt-textarea-short { min-height: 64px; max-height: 160px }

    .sh-prompt-error { font-size: calc(12px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-danger, #e55); }

    /* Actions — matches InputPromptModal.module.css .actions / .btn* */
    .sh-prompt-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .sh-prompt-btn { padding: 8px 18px; border-radius: var(--lcs-radius-sm, 8px); font-size: calc(12.5px * var(--lumiverse-font-scale, 1)); font-weight: 600; font-family: inherit; cursor: pointer; border: 1px solid var(--lumiverse-border); transition: all var(--lumiverse-transition-fast); }
    /* Inline-flex so icon + label sit in a row: the host reset makes svg
       display:block, which otherwise stacks the copy checkmark above the
       label. Harmless for text-only buttons (label stays centered). */
    .sh-prompt-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    .sh-prompt-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Copy confirmation — same success treatment as the lightbox pill. */
    .sh-prompt-btn.sh-copied,
    .sh-prompt-btn.sh-copied:hover:not(:disabled) {
      color: var(--lumiverse-success, #4ade80);
      border-color: var(--lumiverse-success, #4ade80);
    }

    /* Cancel — matches .btnCancel */
    .sh-prompt-btn-cancel { background: transparent; color: var(--lumiverse-text-muted); }
    .sh-prompt-btn-cancel:hover:not(:disabled) { background: var(--lumiverse-fill-subtle, rgba(255,255,255,0.04)); color: var(--lumiverse-text); }

    /* Secondary (Re-run parser) — matches .btnSecondary / .btnSkip */
    .sh-prompt-btn-secondary { background: var(--lumiverse-bg-dark); color: var(--lumiverse-text-dim); }
    .sh-prompt-btn-secondary:hover:not(:disabled) { background: var(--lumiverse-bg-darker); color: var(--lumiverse-text); }

    /* Primary (Generate) — matches .btnSubmit */
    .sh-prompt-btn-primary { background: var(--lumiverse-primary-015, rgba(147,112,219,0.15)); color: var(--lumiverse-primary-text, #c4b5fd); border-color: var(--lumiverse-primary-020, rgba(147,112,219,0.2)); }
    .sh-prompt-btn-primary:hover:not(:disabled) { background: var(--lumiverse-primary-025, rgba(147,112,219,0.25)); border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5)); }

    /* Mobile: action rows snap to an equal-width grid (native has no mobile treatment) */
    @media (max-width: 560px) {
      .sh-prompt-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
      .sh-prompt-actions > :last-child:nth-child(odd) { grid-column: 1 / -1; }
    }

    /* Read-only prompt block (View Prompt modal) — the textarea's visual
       language without the affordance to edit: same border, background,
       type scale, and radius as .sh-prompt-textarea, and the SAME PINNED
       HEIGHTS (120px / 64px short), so this modal's footprint matches the
       insertion modals regardless of prompt length; content scrolls inside. */
    .sh-prompt-readonly {
      height: 120px;
      padding: 12px 14px;
      border-radius: var(--lcs-radius-sm, 8px);
      border: 1px solid var(--lumiverse-border);
      background: var(--lumiverse-bg-dark);
      color: var(--lumiverse-text);
      font-size: calc(13px * var(--lumiverse-font-scale, 1));
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-y: auto;
      overscroll-behavior: contain;
      user-select: text;
      -webkit-user-select: text;
    }
    .sh-prompt-readonly-short { height: 64px; }
    .sh-prompt-viewer-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(13px * var(--lumiverse-font-scale, 1));
      font-style: italic;
      padding: 8px 0;
    }

    /* ── Lightbox prompt label (injected at BODY level, not into the
       portal) ── The wrapper is fixed-positioned via JS and deliberately
       lives outside the native lightbox subtree: the glass-mode backdrop
       has backdrop-filter, and painting inside a filtered subtree makes
       Chromium re-capture the blur (intermittent unblurred-frame flash).
       See the injection site in decorateLightbox. */
    .sh-lightbox-prompt {
      max-height: 156px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 10px 14px 12px;
      background: var(--lumiverse-bg-elevated, rgba(20,20,24,0.92));
      background-clip: padding-box;
      border: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      border-radius: var(--lcs-radius-sm, 8px);
      color: var(--lumiverse-text, #eee);
      font-size: calc(13px * var(--lumiverse-font-scale, 1));
      line-height: 1.45;
      z-index: 10;
      user-select: text;
      -webkit-user-select: text;
      cursor: auto;
      contain: layout paint style;
      will-change: auto;
      transform: none;
      transition: opacity var(--lumiverse-transition-fast, 160ms ease), border-color var(--lumiverse-transition-fast, 160ms ease);
    }

    .sh-lightbox-prompt.sh-swapping {
      opacity: 0.86;
    }
    .sh-lightbox-prompt-content {
      opacity: 1;
      transition: opacity 140ms ease;
    }
    .sh-lightbox-prompt.sh-swapping .sh-lightbox-prompt-content {
      opacity: 0;
    }
    .sh-lightbox-prompt.sh-ready .sh-lightbox-prompt-content {
      animation: sh-lightbox-prompt-content-in 180ms ease-out;
    }
    @keyframes sh-lightbox-prompt-content-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .sh-lightbox-prompt.sh-loading {
      color: var(--lumiverse-text-muted, #999);
      border-color: var(--lumiverse-border, rgba(255,255,255,0.08));
      opacity: 0.88;
    }
    .sh-lightbox-prompt.sh-ready { opacity: 1; }
    .sh-lightbox-prompt-heading {
      font-size: calc(11px * var(--lumiverse-font-scale, 1));
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--lumiverse-text-muted, #999);
      padding-bottom: 4px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      display: flex;
      align-items: center;
      flex: 0 0 auto;
    }
    .sh-lightbox-prompt-scroll {
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      overflow-anchor: none;
      scrollbar-gutter: stable;
      -webkit-overflow-scrolling: touch;
      touch-action: pan-y;
      flex: 1 1 auto;
    }
    .sh-lightbox-prompt-copy {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      flex-shrink: 0;
      margin-left: auto;
      padding: 2px 8px;
      background: var(--lumiverse-fill-subtle, rgba(255,255,255,0.06));
      border: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      border-radius: var(--lcs-radius-sm, 6px);
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(10px * var(--lumiverse-font-scale, 1));
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      line-height: 1.4;
      cursor: pointer;
    }
    .sh-lightbox-prompt-copy:hover { color: var(--lumiverse-text, #eee); border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5)); }
    .sh-lightbox-prompt-copy.sh-copied,
    .sh-lightbox-prompt-copy.sh-copied:hover {
      color: var(--lumiverse-success, #4ade80);
      border-color: var(--lumiverse-success, #4ade80);
    }
    /* Slots for host-rendered shared components (mountCloseButton /
       mountSpinner) — the components own their internal styling so the
       label tracks native design automatically. */
    .sh-lightbox-prompt-close-slot {
      display: inline-flex;
      align-items: center;
      margin-left: 8px;
    }
    .sh-lightbox-prompt-spinner-slot { display: inline-flex; align-items: center; }
    .sh-lightbox-prompt-content { padding-bottom: 2px; }
    .sh-lightbox-prompt-content .sh-lightbox-prompt-text { margin-bottom: 10px; }
    .sh-lightbox-prompt-text:last-child { margin-bottom: 0; }
    .sh-lightbox-prompt-text { white-space: pre-wrap; word-break: break-word; }
    .sh-lightbox-prompt-loading-text {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--lumiverse-text-muted, #999);
      font-style: italic;
    }

    .sh-lightbox-prompt [hidden] { display: none !important; }
    .sh-lightbox-prompt-title {
      flex: 0 0 auto;
    }
    .sh-lightbox-prompt-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(12px * var(--lumiverse-font-scale, 1));
      font-style: italic;
      font-weight: 600;
      text-transform: none;
      letter-spacing: 0;
      line-height: 1.4;
    }
    .sh-lightbox-prompt-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
      flex: 0 0 auto;
    }
    .sh-lightbox-prompt-actions .sh-lightbox-prompt-copy {
      margin-left: 0;
    }
    .sh-lightbox-prompt-view,
    .sh-lightbox-prompt-collapse {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      flex-shrink: 0;
      margin-left: 0;
      padding: 2px 8px;
      background: var(--lumiverse-fill-subtle, rgba(255,255,255,0.06));
      border: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      border-radius: var(--lcs-radius-sm, 6px);
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(10px * var(--lumiverse-font-scale, 1));
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      line-height: 1.4;
      cursor: pointer;
    }
    .sh-lightbox-prompt-view:hover,
    .sh-lightbox-prompt-collapse:hover {
      color: var(--lumiverse-text, #eee);
      border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5));
    }
    .sh-lightbox-prompt.sh-pill {
      height: var(--sh-prompt-pill-height, 44px);
      max-height: var(--sh-prompt-pill-height, 44px);
      min-height: var(--sh-prompt-pill-height, 44px);
      padding: 8px 12px;
      justify-content: center;
    }
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-heading {
      width: 100%;
      padding-bottom: 0;
      margin-bottom: 0;
      border-bottom: 0;
      gap: 10px;
    }
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-scroll {
      display: none !important;
    }
    .sh-lightbox-prompt.sh-expanded {
      height: auto;
      min-height: 0;
    }
    .sh-lightbox-prompt.sh-expanded .sh-lightbox-prompt-heading {
      gap: 8px;
    }
`

// Shared by the lightbox pill's Copy and the View Prompt modal's Copy —
// mirrors native's code-copy confirmation checkmark.
export const COPY_CHECK_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>'
