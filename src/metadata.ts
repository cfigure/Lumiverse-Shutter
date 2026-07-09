// Image-metadata resolution: PNG text-chunk parsing and provider prompt
// decoding (A1111/Forge, NovelAI, ComfyUI), plus the tag/URL helpers built
// on them. Everything here is pure of extension state — no ctx, no settings,
// only browser globals (fetch, DecompressionStream) — so it is safe to use
// from any module.
//
// The Spindle round-trip that RESOLVES a ShutterTag from message markdown
// (resolveShutterTag) is deliberately NOT here: it is message-channel
// plumbing and lives in comms.ts. This module only defines the data shape
// and consumes it.

export const IMAGE_URL_RE = /\/api\/v1\/(?:images|image-gen\/results)\/([a-f0-9-]+)/i

export type ResolvedPrompt = { prompt: string; negativePrompt: string }

// ── PNG text-chunk parsing ──
// PNG layout: 8-byte signature, then chunks of [len u32][type 4ch][data][crc u32].
// tEXt: keyword\0text (latin-1). zTXt: keyword\0compressionMethod, zlib data.
// iTXt: keyword\0compFlag\0compMethod\0lang\0translatedKeyword\0text (utf-8,
// zlib-compressed when compFlag=1). Compressed streams are zlib-wrapped,
// which DecompressionStream('deflate') handles natively.

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return await new Response(stream).text()
}

async function readPngTextChunks(buffer: ArrayBuffer): Promise<Record<string, string>> {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const chunks: Record<string, string> = {}
  // PNG signature
  if (view.byteLength < 8 || view.getUint32(0) !== 0x89504e47) return chunks

  const latin1 = new TextDecoder('latin1')
  const utf8 = new TextDecoder('utf-8')
  let offset = 8
  while (offset + 8 <= view.byteLength) {
    const length = view.getUint32(offset)
    const type = latin1.decode(bytes.subarray(offset + 4, offset + 8))
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd > view.byteLength) break

    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const data = bytes.subarray(dataStart, dataEnd)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = latin1.decode(data.subarray(0, nul))
        try {
          if (type === 'tEXt') {
            chunks[keyword] = latin1.decode(data.subarray(nul + 1))
          } else if (type === 'zTXt') {
            // keyword \0 compressionMethod(1) zlibData
            chunks[keyword] = await inflate(data.subarray(nul + 2))
          } else {
            // iTXt: keyword \0 compFlag(1) compMethod(1) lang \0 translated \0 text
            const compFlag = data[nul + 1]
            let p = nul + 3
            while (p < data.length && data[p] !== 0) p++ // language tag
            p++
            while (p < data.length && data[p] !== 0) p++ // translated keyword
            p++
            const text = data.subarray(p)
            chunks[keyword] = compFlag === 1 ? await inflate(text) : utf8.decode(text)
          }
        } catch { /* skip malformed/incompressible chunk */ }
      }
    }
    if (type === 'IEND') break
    offset = dataEnd + 4 // skip CRC
  }
  return chunks
}

function decodeProviderMetadata(chunks: Record<string, string>): { prompt: string; negativePrompt: string } | null {
  // A1111 / Forge: single 'parameters' chunk, plaintext with a
  // 'Negative prompt:' line followed by a settings line.
  if (chunks.parameters) {
    const text = chunks.parameters
    const negIdx = text.indexOf('\nNegative prompt:')
    if (negIdx !== -1) {
      const rest = text.slice(negIdx + '\nNegative prompt:'.length)
      const settingsIdx = rest.search(/\nSteps: /)
      return {
        prompt: text.slice(0, negIdx).trim(),
        negativePrompt: (settingsIdx === -1 ? rest : rest.slice(0, settingsIdx)).trim(),
      }
    }
    const settingsIdx = text.search(/\nSteps: /)
    return { prompt: (settingsIdx === -1 ? text : text.slice(0, settingsIdx)).trim(), negativePrompt: '' }
  }

  // NovelAI: 'Comment' chunk with JSON ({ prompt, uc, ... }); 'Description'
  // carries the positive prompt as plain text.
  if (chunks.Software === 'NovelAI' || chunks.Comment) {
    try {
      const meta = JSON.parse(chunks.Comment || '{}')
      const prompt = typeof meta.prompt === 'string' ? meta.prompt : (chunks.Description || '')
      if (prompt) {
        return { prompt: prompt.trim(), negativePrompt: typeof meta.uc === 'string' ? meta.uc.trim() : '' }
      }
    } catch { /* fall through */ }
    if (chunks.Description) return { prompt: chunks.Description.trim(), negativePrompt: '' }
  }

  // ComfyUI: 'prompt' chunk is the workflow node graph, not a prompt.
  // Best effort: collect text inputs from CLIPTextEncode-style nodes.
  if (chunks.prompt) {
    try {
      const graph = JSON.parse(chunks.prompt)
      const texts: string[] = []
      for (const node of Object.values(graph) as any[]) {
        if (node && typeof node === 'object' && typeof node.class_type === 'string'
          && node.class_type.includes('CLIPTextEncode')
          && typeof node.inputs?.text === 'string' && node.inputs.text.trim()) {
          texts.push(node.inputs.text.trim())
        }
      }
      if (texts.length > 0) {
        return { prompt: texts[0], negativePrompt: texts.length > 1 ? texts.slice(1).join('\n---\n') : '' }
      }
    } catch { /* fall through */ }
  }

  return null
}

// Resolved-tag info from the message markdown: the authoritative image ID
// and the original tag path (the route that serves unmodified provider
// bytes). Host builds may rewrite rendered/lightbox srcs to separate display
// identities and thumbnail tiers, so metadata is most reliable when fetched
// from the markdown tag path rather than the lightbox URL.
export type ShutterTag = { imageId: string; path: string }

async function fetchMetadataPrompt(url: string): Promise<{ prompt: string; negativePrompt: string } | null> {
  try {
    // Strip any thumbnail tier — tiered responses are sharp-re-encoded and
    // metadata-stripped; un-tiered routes serve original provider bytes.
    const resp = await fetch(url.split('?')[0], { credentials: 'include' })
    if (!resp.ok) return null
    return decodeProviderMetadata(await readPngTextChunks(await resp.arrayBuffer()))
  } catch {
    return null
  }
}

export async function resolvePromptForImage(tag: ShutterTag | null, lightboxSrc: string): Promise<ResolvedPrompt | null> {
  let resolved: ResolvedPrompt | null = null

  // 1. Provider-embedded metadata from the original Shutter tag URL.
  if (tag) {
    const decoded = await fetchMetadataPrompt(tag.path)
    if (decoded) resolved = decoded
  }

  // 2. Last resort: metadata from whatever the lightbox is showing.
  if (!resolved) {
    const decoded = await fetchMetadataPrompt(lightboxSrc)
    if (decoded) resolved = decoded
  }

  return resolved
}

export function extractImageId(src: string): string | null {
  const match = src.match(IMAGE_URL_RE)
  return match ? match[1] : null
}
