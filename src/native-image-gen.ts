import type { GenerationTarget } from './history'

export type GenerationResult = {
  imageId: string
  imageUrl: string
  handledByNative: boolean
  prompt: string
  negativePrompt: string
  promptMode: string
  provider?: string
  model?: string
}

export type GenerationSkipped = {
  skipped: true
  reason: string
}

type ImageGenerationSource = {
  providerId: string
  model: string
  defaultNegativePrompt: string
}

export function parseErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    const msg = parsed.message || parsed.error?.message || (typeof parsed.error === 'string' ? parsed.error : null)
    if (msg) return msg
  } catch { /* not full JSON — try substring */ }

  try {
    const i = raw.indexOf('{')
    if (i >= 0) {
      const parsed = JSON.parse(raw.slice(i))
      const msg = parsed.message || parsed.error?.message || (typeof parsed.error === 'string' ? parsed.error : null)
      if (msg) return msg
    }
  } catch { /* not JSON at all */ }

  return raw
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : ''
}

export function createNativeImageGen() {
  let cachedNativeSettings: Record<string, any> | null = null
  let cachedImageProviderLabels: Map<string, string> | null = null

  async function fetchJsonBestEffort(url: string, timeoutMs = 2000): Promise<any | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) return null
      return await response.json()
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  async function getImageProviderLabels(): Promise<Map<string, string>> {
    if (cachedImageProviderLabels) return cachedImageProviderLabels
    const data = await fetchJsonBestEffort('/api/v1/image-gen-connections/providers')
    const labels = new Map<string, string>()
    if (Array.isArray(data?.providers)) {
      for (const provider of data.providers) {
        if (typeof provider?.id === 'string' && typeof provider?.name === 'string') {
          labels.set(provider.id, provider.name)
        }
      }
    }
    if (labels.size > 0) cachedImageProviderLabels = labels
    return labels
  }

  async function resolveImageGenerationSource(connectionId: unknown): Promise<ImageGenerationSource | null> {
    if (typeof connectionId !== 'string' || !connectionId) return null
    const connection = await fetchJsonBestEffort(`/api/v1/image-gen-connections/${encodeURIComponent(connectionId)}`)
    if (!connection || typeof connection.provider !== 'string') return null
    return {
      providerId: connection.provider,
      model: typeof connection.model === 'string' ? connection.model : '',
      defaultNegativePrompt: nonEmptyString(connection.default_parameters?.negativePrompt),
    }
  }

  // These native scene-pipeline routes have no Spindle API equivalent and
  // authenticate through the user's browser session, so they stay frontend-side.
  async function fetchNativeSettings(): Promise<Record<string, any>> {
    try {
      const resp = await fetch('/api/v1/settings/imageGeneration')
      if (!resp.ok) throw new Error(await resp.text())

      const data = await resp.json()
      const settings = data?.value
      if (!settings || typeof settings !== 'object') throw new Error('No settings were found.')

      cachedNativeSettings = settings
      return settings
    } catch (err: any) {
      if (cachedNativeSettings !== null) return cachedNativeSettings
      const details = err?.message ? ` ${parseErrorMessage(err.message)}` : ''
      throw new Error(`Native ImageGen settings could not be loaded. Make sure Lumiverse ImageGen is available and configured.${details}`)
    }
  }

  async function callImageGen(
    chatId: string,
    overrides?: Record<string, any>,
    target?: GenerationTarget,
  ): Promise<GenerationResult | GenerationSkipped> {
    const native = await fetchNativeSettings()
    const sourcePromise = resolveImageGenerationSource(native.activeImageGenConnectionId)
    const providerLabelsPromise = getImageProviderLabels()
    const body: Record<string, any> = {
      ...native,
      ...overrides,
      chatId,
    }

    if (body.outputTarget === 'attach_to_message' && target) {
      body.attachToMessageId = target.messageId
    }

    const resp = await fetch('/api/v1/image-gen/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) throw new Error(await resp.text())
    const result = await resp.json()
    if (!result.generated) {
      return { skipped: true, reason: result.reason || 'Scene has not changed enough' }
    }
    if (!result.imageId) throw new Error('The image was generated but could not be saved.')

    const providerId = typeof result.provider === 'string' ? result.provider : ''
    const [source, providerLabels] = await Promise.all([sourcePromise, providerLabelsPromise])
    const provider = providerId ? (providerLabels.get(providerId) || '') : ''
    const model = source && source.providerId === providerId ? source.model : ''

    // Older Lumiverse builds return only the parser-supplied negative prompt,
    // even when the connection default was sent to the provider. Prefer the
    // returned/explicit value and use the connection default only when both
    // are genuinely absent.
    const negativePrompt = nonEmptyString(result.negativePrompt)
      || nonEmptyString(overrides?.negativePrompt)
      || source?.defaultNegativePrompt
      || ''

    return {
      imageId: result.imageId,
      imageUrl: result.imageUrl || `/api/v1/image-gen/results/${result.imageId}`,
      handledByNative: !!result.message,
      prompt: typeof result.prompt === 'string' ? result.prompt : (typeof overrides?.prompt === 'string' ? overrides.prompt : ''),
      negativePrompt,
      promptMode: overrides?.skipParse ? 'custom' : (typeof body.promptMode === 'string' ? body.promptMode : 'scene'),
      provider: provider || undefined,
      model: model || undefined,
    }
  }

  async function callPreviewPrompt(chatId: string): Promise<{ prompt: string; negativePrompt: string }> {
    const native = await fetchNativeSettings()
    const sourcePromise = resolveImageGenerationSource(native.activeImageGenConnectionId)
    const resp = await fetch('/api/v1/image-gen/preview-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId,
        promptMode: native.promptMode,
        prompt: native.customPrompt,
        negativePrompt: native.customNegativePrompt,
        promptPresetId: native.activePromptPresetId,
        promptGenerationTimeoutSeconds: native.promptGenerationTimeoutSeconds,
      }),
    })
    if (!resp.ok) throw new Error(await resp.text())
    const result = await resp.json()
    const source = await sourcePromise
    return {
      prompt: result.prompt || '',
      negativePrompt: nonEmptyString(result.negativePrompt)
        || nonEmptyString(native.customNegativePrompt)
        || source?.defaultNegativePrompt
        || '',
    }
  }

  return { fetchNativeSettings, callImageGen, callPreviewPrompt }
}
