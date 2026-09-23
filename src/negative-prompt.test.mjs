import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePreviewPrompt } from './negative-prompt.ts'

const source = { providerId: 'swarmui', defaultNegativePrompt: 'blurry, low quality' }

test('preview includes a configured default when parser supplies no negative prompt', () => {
  assert.deepEqual(resolvePreviewPrompt({ provider: 'swarmui', prompt: 'forest', negativePrompt: '' }, source), {
    prompt: 'forest', negativePrompt: 'blurry, low quality',
  })
})

test('parsed negative prompt takes precedence without duplicating the default', () => {
  assert.equal(resolvePreviewPrompt({ provider: 'swarmui', negativePrompt: 'blurry, low quality, fog' }, source).negativePrompt,
    'blurry, low quality, fog')
})

test('default from another provider is not shown', () => {
  assert.equal(resolvePreviewPrompt({ provider: 'sdapi', negativePrompt: '' }, source).negativePrompt, '')
})

test('missing source or missing default keeps the preview empty', () => {
  assert.equal(resolvePreviewPrompt({ provider: 'swarmui' }, null).negativePrompt, '')
  assert.equal(resolvePreviewPrompt({ provider: 'swarmui' }, { ...source, defaultNegativePrompt: '' }).negativePrompt, '')
})
