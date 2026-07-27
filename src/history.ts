// Durable Shutter generation-history data shared by the frontend and backend.
// Keep this module environment-neutral: it is bundled into both entries.

export type GenerationOrigin = 'manual' | 'auto' | 'regenerate' | 'rebuild' | 'preview'

export type GenerationTarget = {
  chatId: string
  messageId: string
  swipeId: number
  swipeDate: number | null
  swipeFingerprint: string
  duplicateSwipeDate: boolean
  historyEpoch: number
}

export type GenerationHistoryRecord = {
  version: 1
  imageId: string
  createdAt: number
  prompt: string
  negativePrompt: string
  promptMode: string
  origin: GenerationOrigin
  provider?: string
  model?: string
  target: GenerationTarget
}

export type GenerationHistoryInput = {
  imageId: string
  prompt: string
  negativePrompt: string
  promptMode: string
  origin: GenerationOrigin
  provider?: string
  model?: string
}

export type PromptMetadataView = {
  source: 'shutter' | 'embedded'
  prompt: string
  negativePrompt: string
  createdAt?: number
  promptMode?: string
  origin?: GenerationOrigin
  provider?: string
  model?: string
}

const SHUTTER_IMAGE_GLOBAL_RE = /\n*!\[shutter\]\(\/api\/v1\/(?:images|image-gen\/results)\/[a-f0-9-]+\)/gi

export function normaliseSwipeContent(content: string): string {
  return content
    .replace(SHUTTER_IMAGE_GLOBAL_RE, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

// A small deterministic fingerprint. It is an identity hint, not a security
// primitive; swipe_dates remains the primary durable swipe identity.
export function fingerprintSwipeContent(content: string): string {
  const value = normaliseSwipeContent(content)
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function imageUrlForHistoryRecord(record: Pick<GenerationHistoryRecord, 'imageId'>): string {
  return `/api/v1/image-gen/results/${record.imageId}`
}

export function promptViewFromRecord(record: GenerationHistoryRecord): PromptMetadataView {
  return {
    source: 'shutter',
    prompt: record.prompt,
    negativePrompt: record.negativePrompt,
    createdAt: record.createdAt,
    promptMode: record.promptMode,
    origin: record.origin,
    provider: record.provider,
    model: record.model,
  }
}

export function promptViewFromEmbedded(prompt: string, negativePrompt: string): PromptMetadataView {
  return { source: 'embedded', prompt, negativePrompt }
}

export function humanisePromptMode(mode?: string): string {
  if (!mode) return ''
  return mode
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

export function humaniseGenerationOrigin(origin?: GenerationOrigin): string {
  if (!origin) return ''
  switch (origin) {
    case 'auto': return 'Automatic generation'
    case 'regenerate': return 'Regenerate image'
    case 'rebuild': return 'Rebuild prompt'
    case 'preview': return 'Prompt preview'
    default: return 'Manual generation'
  }
}


export function formatPromptMetadataLine(view: PromptMetadataView): string {
  const details: string[] = []
  if (view.createdAt) details.push(new Date(view.createdAt).toLocaleString())
  if (view.provider) details.push(view.provider)
  if (view.model) details.push(view.model)
  return details.join(' · ')
}

export function formatPromptMetadataForClipboard(view: PromptMetadataView): string {
  const lines: string[] = ['Positive Prompt', view.prompt]
  if (view.negativePrompt) lines.push('', 'Negative Prompt', view.negativePrompt)
  return lines.join('\n')
}
