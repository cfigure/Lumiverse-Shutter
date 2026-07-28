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
    .sh-settings-danger-btn {
      flex-shrink: 0;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--lumiverse-danger, #e55) 45%, var(--lumiverse-border));
      background: color-mix(in srgb, var(--lumiverse-danger, #e55) 10%, transparent);
      color: var(--lumiverse-danger, #e55);
      font: inherit;
      font-size: calc(12px * var(--lumiverse-font-scale, 1));
      font-weight: 600;
      cursor: pointer;
      transition: background var(--lumiverse-transition-fast), border-color var(--lumiverse-transition-fast);
    }
    .sh-settings-danger-btn:hover:not(:disabled) {
      background: color-mix(in srgb, var(--lumiverse-danger, #e55) 18%, transparent);
      border-color: var(--lumiverse-danger, #e55);
    }
    .sh-settings-danger-btn:disabled { opacity: 0.5; cursor: not-allowed; }
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
    /* Generation History deliberately inherits the same body gap and preview
       sizing as Image Generated. Extra History content must fit around that
       established preview budget rather than making the preview taller. */
    .sh-generation-meta {
      min-width: 0;
      padding: 0 2px 2px;
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(11px * var(--lumiverse-font-scale, 1));
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    /* Image preview — matches ImageGenPanel.module.css */
    .sh-preview { position: relative; border: 1px solid var(--lumiverse-border); border-radius: 10px; overflow: hidden; cursor: zoom-in; background: var(--lumiverse-bg-elevated); }
    .sh-preview img { display: block; width: 100%; max-height: min(34vh, 340px); object-fit: contain; }
    /* Missing-image presentation is deliberately compact and participates in
       normal layout. It does not preserve the broken image's dimensions or
       overlay an invisible image. */
    .sh-preview > img[hidden] { display: none !important; }
    .sh-preview.sh-preview-unavailable { cursor: default; }
    .sh-image-unavailable[hidden] { display: none !important; }
    .sh-image-unavailable {
      width: 100%;
      height: min(24vh, 180px);
      min-height: 0;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin: 0;
      padding: 0;
      text-align: center;
      color: var(--lumiverse-text-muted, #999);
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--lumiverse-fill-subtle, rgba(255,255,255,0.05)) 65%, transparent), transparent),
        var(--lumiverse-bg-elevated);
    }
    .sh-image-unavailable-icon {
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--lumiverse-text-dim, #777);
      opacity: 0.9;
    }
    .sh-image-unavailable-icon svg { width: 100%; height: 100%; }
    .sh-image-unavailable-title {
      color: var(--lumiverse-text, #eee);
      font-size: calc(15px * var(--lumiverse-font-scale, 1));
      font-weight: 650;
      line-height: 1.3;
    }
    .sh-image-unavailable-detail {
      width: min(420px, calc(100% - 24px));
      font-size: calc(12px * var(--lumiverse-font-scale, 1));
      line-height: 1.5;
    }

    /* ── Generation history nav — matches SwipeControls.module.css (.bubble variant) ── */
    .sh-hist-pill { position: absolute; right: 10px; bottom: 10px; display: flex; align-items: center; gap: 2px; padding: 2px 4px; border-radius: 16px; background: var(--lumiverse-fill-heavy); border: 1px solid var(--lumiverse-border); font-family: ui-monospace, 'SF Mono', SFMono-Regular, 'Cascadia Code', Menlo, Consolas, monospace; font-size: calc(11px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-dim); letter-spacing: 0.04em; z-index: 2; cursor: default; }
    .sh-hist-btn { position: relative; display: flex; align-items: center; justify-content: center; width: var(--lumiverse-btn-icon-sm, 24px); height: var(--lumiverse-btn-icon-sm, 24px); padding: 0; background: transparent; border: none; border-radius: 6px; color: var(--lumiverse-text-dim); cursor: pointer; transition: all var(--lumiverse-transition-fast, 0.15s); }
    /* Invisible hit-area extension: ~40px effective touch target while the
       visual stays at native SwipeControls size. */
    .sh-hist-btn::after { content: ''; position: absolute; inset: -8px; }
    .sh-hist-btn:hover:not(:disabled) { background: var(--lumiverse-fill-subtle); color: var(--lumiverse-text); }
    .sh-hist-btn:disabled { color: var(--lumiverse-text-hint); opacity: 1; cursor: default; }
    .sh-hist-btn svg { width: 16px; height: 16px; }
    .sh-hist-counter { min-width: 32px; text-align: center; user-select: none; font-variant-numeric: tabular-nums; }
    /* Mobile: same position, reduced chrome weight (type unchanged — Shutter's
       type scale is universal; layout adapts, fonts don't). Buttons/icons/
       padding shrink ~18%; expanded hit-areas hold ~40px touch targets.
       Breakpoint matches the modal's action-grid pivot below. */
    @media (max-width: 560px) {
      .sh-hist-pill { right: 6px; bottom: 6px; gap: 1px; padding: 2px 3px; border-radius: 14px; }
      .sh-hist-btn { width: 20px; height: 20px; }
      .sh-hist-btn::after { inset: -10px; }
      .sh-hist-btn svg { width: 14px; height: 14px; }
      .sh-hist-counter { min-width: 26px; }
    }

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

    /* Compact source controls shared by the Image Prompt modal and the
       expanded lightbox prompt area. */
    .sh-prompt-source-tabs {
      display: inline-flex;
      align-items: center;
      align-self: flex-start;
      width: fit-content;
      max-width: 100%;
      gap: 6px;
      padding: 0;
      margin: 0;
      border: 0;
      background: transparent;
      flex-wrap: nowrap;
      white-space: nowrap;
    }
    .sh-prompt-source-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      min-width: 0;
      padding: 2px 10px;
      border: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      border-radius: var(--lcs-radius-sm, 6px);
      background: var(--lumiverse-fill-subtle, rgba(255,255,255,0.06));
      color: var(--lumiverse-text-muted, #999);
      font: inherit;
      font-size: calc(10px * var(--lumiverse-font-scale, 1));
      font-weight: 600;
      line-height: 1.4;
      cursor: pointer;
      white-space: nowrap;
      transition: background var(--lumiverse-transition-fast), border-color var(--lumiverse-transition-fast), color var(--lumiverse-transition-fast);
    }
    .sh-prompt-source-btn:hover {
      color: var(--lumiverse-text, #eee);
      border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5));
    }
    .sh-prompt-source-btn.sh-active {
      background: var(--lumiverse-fill-heavy, rgba(255,255,255,0.1));
      border-color: var(--lumiverse-primary-020, rgba(147,112,219,0.2));
      color: var(--lumiverse-text, #eee);
    }
    .sh-prompt-source-meta {
      margin-bottom: 8px;
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
      line-height: 1.4;
    }
    .sh-prompt-source-fields { display: flex; flex-direction: column; gap: 12px; }

    /* Image Prompt keeps Shutter's established prompt-modal structure. The
       host body is made non-scrolling in code; only these read-only prompt
       boxes scroll internally, leaving the standard footer visible. */
    .sh-image-prompt-root { width: 100%; min-height: 0; }
    .sh-image-prompt-body { min-height: 0; overflow: hidden; gap: 14px; }
    .sh-image-prompt-meta {
      margin: -2px 0 0;
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(11px * var(--lumiverse-font-scale, 1));
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .sh-image-prompt-fields { min-height: 0; overflow: hidden; gap: 14px; }
    .sh-image-prompt-readonly { box-sizing: border-box; cursor: text; background: rgba(255, 255, 255, 0.018); border-color: rgba(255, 255, 255, 0.10); border-radius: 10px; }
    .sh-image-prompt-field-positive .sh-image-prompt-readonly { height: 120px; }
    .sh-image-prompt-field-negative .sh-image-prompt-readonly { height: 64px; }
    .sh-image-prompt-fields.sh-no-negative .sh-image-prompt-field-positive .sh-image-prompt-readonly { height: 196px; }
    .sh-image-prompt-actions { flex: 0 0 auto; }
    @media (max-height: 520px) {
      .sh-image-prompt-field-positive .sh-image-prompt-readonly { height: 92px; }
      .sh-image-prompt-field-negative .sh-image-prompt-readonly { height: 52px; }
      .sh-image-prompt-fields.sh-no-negative .sh-image-prompt-field-positive .sh-image-prompt-readonly { height: 156px; }
    }

    /* ── Lightbox prompt label (injected at BODY level, not into the
       portal) ── The wrapper is fixed-positioned via JS and deliberately
       lives outside the native lightbox subtree: the glass-mode backdrop
       has backdrop-filter, and painting inside a filtered subtree makes
       Chromium re-capture the blur (intermittent unblurred-frame flash).
       See the injection site in decorateLightbox. */
    .sh-lightbox-prompt {
      width: fit-content;
      min-width: 0;
      max-width: calc(var(--app-scaled-viewport-width, 100vw) - 24px);
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
      color: var(--lumiverse-text-muted, #999);
      padding-bottom: 4px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      display: flex;
      align-items: center;
      justify-content: center;
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
    /* The spinner remains host-rendered; Hide uses Shutter's standard
       compact lightbox-button treatment for visual consistency. */
    .sh-lightbox-prompt-spinner-slot { display: inline-flex; align-items: center; }
    .sh-lightbox-prompt-content { padding-bottom: 2px; }
    .sh-lightbox-prompt-content > .sh-lightbox-prompt-heading {
      justify-content: flex-start;
      text-align: left;
    }
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
      gap: 6px;
      margin-left: 0;
      flex: 0 0 auto;
      flex-wrap: nowrap;
      white-space: nowrap;
    }
    .sh-lightbox-prompt-copy,
    .sh-lightbox-prompt-history,
    .sh-lightbox-prompt-view,
    .sh-lightbox-prompt-collapse,
    .sh-lightbox-prompt-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      white-space: nowrap;
      flex-shrink: 0;
      margin-left: 0;
      padding: 4px 8px;
      background: var(--lumiverse-fill-subtle, rgba(255,255,255,0.06));
      border: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      border-radius: var(--lcs-radius-sm, 6px);
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(10px * var(--lumiverse-font-scale, 1));
      font-weight: 600;
      line-height: 1.4;
      cursor: pointer;
    }
    .sh-lightbox-prompt-copy:hover,
    .sh-lightbox-prompt-history:hover,
    .sh-lightbox-prompt-view:hover,
    .sh-lightbox-prompt-collapse:hover,
    .sh-lightbox-prompt-close:hover {
      color: var(--lumiverse-text, #eee);
      border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5));
    }
    .sh-lightbox-prompt-copy.sh-copied,
    .sh-lightbox-prompt-copy.sh-copied:hover {
      color: var(--lumiverse-success, #4ade80);
      border-color: var(--lumiverse-success, #4ade80);
    }
    .sh-lightbox-prompt.sh-pill {
      width: 100%;
      min-width: 0;
      height: var(--sh-prompt-pill-height, 44px);
      max-height: var(--sh-prompt-pill-height, 44px);
      min-height: var(--sh-prompt-pill-height, 44px);
      padding: 7px 9px;
      justify-content: center;
      white-space: nowrap;
    }
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-heading {
      width: 100%;
      min-width: 0;
      justify-content: center;
      padding-bottom: 0;
      margin-bottom: 0;
      border-bottom: 0;
      gap: 6px;
      flex-wrap: nowrap;
    }
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-actions {
      width: auto;
      min-width: 0;
      justify-content: center;
      gap: 5px;
      margin-left: 0;
      flex-wrap: nowrap;
    }
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-history,
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-view,
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-collapse,
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-copy,
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-close {
      font-size: calc(9.5px * var(--lumiverse-font-scale, 1));
    }
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-scroll {
      display: none !important;
    }
    .sh-lightbox-prompt.sh-expanded {
      width: 100%;
      height: auto;
      min-height: 0;
    }
    .sh-lightbox-prompt-source-row {
      display: flex;
      justify-content: center;
      width: 100%;
      margin-bottom: 8px;
    }
    .sh-lightbox-prompt-source-row .sh-prompt-source-tabs {
      margin: 0;
    }
    .sh-lightbox-prompt.sh-expanded .sh-lightbox-prompt-heading {
      gap: 8px;
    }
`

// Shared by the lightbox pill's Copy and the View Prompt modal's Copy —
// mirrors native's code-copy confirmation checkmark.
export const COPY_CHECK_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>'
