// Lumiverse's preview endpoint returns the parser result. Connection defaults
// are applied later by the provider when the parsed negative prompt is empty.
export function resolvePreviewPrompt(
  result: { prompt?: unknown; negativePrompt?: unknown; provider?: unknown },
  source: { providerId: string; defaultNegativePrompt: string } | null,
): { prompt: string; negativePrompt: string } {
  const parsed = typeof result.negativePrompt === 'string' ? result.negativePrompt : ''
  const connectionDefault = source?.providerId === result.provider ? source.defaultNegativePrompt : ''
  return {
    prompt: typeof result.prompt === 'string' ? result.prompt : '',
    negativePrompt: parsed || connectionDefault,
  }
}
