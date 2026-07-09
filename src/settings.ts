// Shared settings model — the single source of truth for Shutter's settings
// shape, defaults, and validation. Imported by BOTH entries (backend.ts and
// frontend.ts); bun bundles it into each dist file, so the host still sees
// exactly two self-contained bundles. Everything here must stay
// environment-neutral: no `spindle`, no DOM, no browser globals.
//
// Adding a setting touches this file only (type + default + validation),
// plus wherever the setting is actually used.

// ── Icon IDs ──
// Defined here (not icons.ts) so backend validation can consume the runtime
// list without pulling the SVG payloads into the backend bundle. icons.ts
// derives its ShutterIconSet record from this same type.

export const SHUTTER_ICON_IDS = ['aperture', 'cherry_blossom', 'cat_lotus'] as const
export type ShutterIconId = (typeof SHUTTER_ICON_IDS)[number]

// ── Settings ──

export type Settings = {
  showFloatWidget: boolean
  toastOnInsert: boolean
  afterGenerate: 'ask_to_insert' | 'auto_insert'
  widgetSize: 'small' | 'medium' | 'large' | 'xlarge'
  widgetStyle: 'color' | 'mono'
  iconTheme: ShutterIconId
  autoGenerate: 'off' | 'every' | 'interval' | 'random'
  autoGenerateInterval: number
  autoGenerateRandomMin: number
  autoGenerateRandomMax: number
  autoGenerateAfter: 'auto_insert' | 'ask_to_insert'
  autoPreviewPrompt: boolean
  defaultAction: 'append' | 'replace'
  deleteConfirmation: 'never' | 'bulk_only' | 'always'
  removeImageTagsFromContext: boolean
  showPromptInLightbox: boolean
  shutterImageLayout: 'off' | 'custom'
  shutterImageWidth: number
  shutterImageAlign: 'left' | 'center' | 'right'
}

// The runtime source of defaults. There is deliberately NO defaults/*.json
// seed file: `storage_seed_files` copies into extension storage
// ({DATA_DIR}/extensions/shutter/storage/), but settings live in
// spindle.userStorage ({DATA_DIR}/users/{userId}/extensions/shutter/) — so a
// seed was never read. loadSettings() spreads these defaults over whatever
// userStorage returns (fallback {}), which fully covers fresh installs.
export const DEFAULT_SETTINGS: Settings = {
  showFloatWidget: false,
  toastOnInsert: true,
  afterGenerate: 'ask_to_insert',
  widgetSize: 'small',
  widgetStyle: 'color',
  iconTheme: 'aperture',
  autoGenerate: 'off',
  autoGenerateInterval: 3,
  autoGenerateRandomMin: 3,
  autoGenerateRandomMax: 7,
  autoGenerateAfter: 'auto_insert',
  autoPreviewPrompt: false,
  defaultAction: 'append',
  deleteConfirmation: 'bulk_only',
  removeImageTagsFromContext: true,
  showPromptInLightbox: false,
  shutterImageLayout: 'off',
  shutterImageWidth: 50,
  shutterImageAlign: 'center',
}

// Shared by backend validation, the settings panel's percent input, and the
// frontend's inline image-layout stylesheet.
export function clampShutterImageWidth(value: number): number {
  if (!Number.isFinite(value)) return 100
  return Math.max(1, Math.min(100, Math.round(value * 10) / 10))
}

// ── Validation ──
// Pure; the backend is the authority (it validates on every load and save),
// the frontend only mirrors validated settings echoed back over the channel.

export function validateSettings(s: Settings): Settings {
  const out = { ...s }

  // Migration (1.0.6): 'forceGeneration' was removed — Shutter now defers to
  // native ImageGen's scene-change settings ("Ignore Scene Change Detection"
  // and the threshold). 1.0.5 shipped the key in DEFAULT_SETTINGS and
  // saveSettings re-persists the whole merged object on every save, so the
  // stale key never self-cleans from users' settings.json; strip it here on
  // the next write. Safe to delete this line once 1.0.5-era installs have
  // aged out.
  delete (out as Record<string, unknown>).forceGeneration

  if (!SHUTTER_ICON_IDS.includes(out.iconTheme)) {
    out.iconTheme = 'aperture'
  }

  out.autoGenerateInterval = Math.max(
    1,
    Math.round(out.autoGenerateInterval),
  )
  out.autoGenerateRandomMin = Math.max(
    1,
    Math.round(out.autoGenerateRandomMin),
  )
  out.autoGenerateRandomMax = Math.max(
    out.autoGenerateRandomMin,
    Math.round(out.autoGenerateRandomMax),
  )

  if (out.shutterImageLayout !== 'off' && out.shutterImageLayout !== 'custom') {
    out.shutterImageLayout = 'off'
  }
  if (
    out.shutterImageAlign !== 'left' &&
    out.shutterImageAlign !== 'center' &&
    out.shutterImageAlign !== 'right'
  ) {
    out.shutterImageAlign = 'center'
  }
  out.shutterImageWidth = clampShutterImageWidth(Number(out.shutterImageWidth) || 100)

  return out
}
