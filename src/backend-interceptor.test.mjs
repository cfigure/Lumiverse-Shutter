import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'bun'

// Exercise the complete backend with only the Spindle host boundary replaced.
const bundled = await build({
  entrypoints: [fileURLToPath(new URL('./backend.ts', import.meta.url))],
  target: 'bun',
  format: 'cjs',
})
assert.equal(bundled.success, true, bundled.logs.join('\n'))
const backendSource = await bundled.outputs[0].text()

const tag = '![shutter](/api/v1/images/a1-b2)'
const imageMessages = () => [{ role: 'assistant', content: `before\n${tag} after` }]

function deferred() {
  let resolve
  const promise = new Promise(fulfill => { resolve = fulfill })
  return { promise, resolve }
}

function createBackend(settings = new Map(), initiallyGranted = true) {
  let granted = initiallyGranted
  let frontendHandler
  let changedHandler
  let deniedHandler
  let active
  let readSettings = async userId => settings.get(userId) ?? {}
  const reads = []
  const registrations = []
  const replies = []
  const spindle = {
    userStorage: {
      async getJson(path, { userId }) {
        assert.equal(path, 'settings.json')
        assert.ok(userId, 'operator-scoped storage requires an explicit invoking user')
        reads.push(userId)
        return readSettings(userId)
      },
      async setJson(path, value, { userId }) {
        assert.equal(path, 'settings.json')
        assert.ok(userId)
        settings.set(userId, value)
      },
    },
    permissions: {
      has: permission => permission === 'interceptor' && granted,
      onChanged: handler => { changedHandler = handler },
      onDenied: handler => { deniedHandler = handler },
    },
    registerInterceptor(handler) {
      const registration = { handler, disposeCount: 0 }
      registrations.push(registration)
      active = registration
      return () => {
        registration.disposeCount++
        if (active === registration) active = null
      }
    },
    onFrontendMessage: handler => { frontendHandler = handler },
    sendToFrontend: (payload, userId) => { replies.push({ payload, userId }) },
    log: { info() {}, warn() {}, error() {} },
  }
  const module = { exports: {} }
  const initialize = runInNewContext(backendSource, { spindle, module })
  initialize(module.exports, undefined, module, 'backend.js', '.')
  return {
    settings,
    reads,
    registrations,
    replies,
    get active() { return active },
    invoke: (userId, messages) => active.handler(messages, { userId }),
    frontend: (payload, userId) => frontendHandler(payload, userId),
    setReader: reader => { readSettings = reader },
    setPermission(value) {
      granted = value
      changedHandler({ permission: 'interceptor', granted: value })
    },
    denyRegistration() {
      deniedHandler({ permission: 'interceptor', operation: 'registerInterceptor' })
    },
  }
}

test('saved opt-out is respected immediately after startup and restart without frontend activity', async () => {
  const runtime = createBackend(new Map([['alice', { removeImageTagsFromContext: false }]]))
  assert.equal(runtime.reads.length, 0, 'startup must not load unscoped settings')
  const messages = imageMessages()
  assert.strictEqual(await runtime.invoke('alice', messages), messages)
  assert.deepEqual(runtime.reads, ['alice'])

  const restarted = createBackend(runtime.settings)
  assert.equal(restarted.reads.length, 0)
  assert.strictEqual(await restarted.invoke('alice', messages), messages)
})

test('alternating users and frontend settings messages never share context-filter preferences', async () => {
  const runtime = createBackend(new Map([
    ['alice', { removeImageTagsFromContext: false }],
    ['bob', { removeImageTagsFromContext: true }],
  ]))
  const messages = imageMessages()
  await runtime.frontend({ type: 'request_settings' }, 'bob')
  assert.strictEqual(await runtime.invoke('alice', messages), messages)
  assert.equal((await runtime.invoke('bob', messages))[0].content, 'before after')
  await runtime.frontend({ type: 'update_settings', settings: { removeImageTagsFromContext: false } }, 'bob')
  assert.strictEqual(await runtime.invoke('bob', messages), messages)
  await runtime.frontend({ type: 'update_settings', settings: { removeImageTagsFromContext: true } }, 'alice')
  assert.equal((await runtime.invoke('alice', messages))[0].content, 'before after')
  assert.strictEqual(await runtime.invoke('bob', messages), messages)
  assert.deepEqual(runtime.replies.map(reply => reply.userId), ['bob', 'bob', 'alice'])
  assert.equal(messages[0].content, `before\n${tag} after`, 'filtering never changes stored chat content')
})

test('overlapping invocations use their own settings even when reads finish in reverse order', async () => {
  const runtime = createBackend()
  const alice = deferred()
  const bob = deferred()
  runtime.setReader(userId => userId === 'alice' ? alice.promise : bob.promise)
  const messages = imageMessages()
  const aliceResult = runtime.invoke('alice', messages)
  const bobResult = runtime.invoke('bob', messages)
  assert.deepEqual(runtime.reads, ['alice', 'bob'])
  bob.resolve({ removeImageTagsFromContext: true })
  assert.equal((await bobResult)[0].content, 'before after')
  alice.resolve({ removeImageTagsFromContext: false })
  assert.strictEqual(await aliceResult, messages)
})

test('filtering preserves non-text multimodal parts and strips both Shutter URL routes', async () => {
  const runtime = createBackend()
  const image = { type: 'image', data: 'image-data', mime_type: 'image/png' }
  const video = { type: 'video', data: 'video-data', mime_type: 'video/mp4' }
  const ordinaryTag = '![other](/api/v1/images/a1-b2)'
  const text = { type: 'text', text: `first\n${tag} second\n![SHUTTER](/api/v1/image-gen/results/c3-d4) ${ordinaryTag}` }
  const messages = [{ role: 'user', name: 'Alice', content: [text, image, video] }]
  const result = await runtime.invoke('alice', messages)
  assert.equal(result[0].name, 'Alice')
  assert.equal(result[0].content[0].text, `first second ${ordinaryTag}`)
  assert.strictEqual(result[0].content[1], image)
  assert.strictEqual(result[0].content[2], video)
  assert.equal(text.text, `first\n${tag} second\n![SHUTTER](/api/v1/image-gen/results/c3-d4) ${ordinaryTag}`)
})

test('revocation disposes the registration and makes captured callbacks inert; regrant registers once', async () => {
  const runtime = createBackend(new Map(), false)
  assert.equal(runtime.registrations.length, 0)
  runtime.setPermission(true)
  runtime.setPermission(true)
  assert.equal(runtime.registrations.length, 1)
  const oldRegistration = runtime.active
  runtime.setPermission(false)
  assert.equal(oldRegistration.disposeCount, 1)
  assert.equal(runtime.active, null)
  const messages = imageMessages()
  assert.strictEqual(await oldRegistration.handler(messages, { userId: 'alice' }), messages)
  assert.equal(runtime.reads.length, 0)

  runtime.setPermission(true)
  assert.equal(runtime.registrations.length, 2)
  assert.strictEqual(await oldRegistration.handler(messages, { userId: 'alice' }), messages)
  assert.equal(runtime.reads.length, 0, 'a disposed callback stays inert after regrant')
  assert.equal((await runtime.invoke('alice', messages))[0].content, 'before after')
})

test('revocation during an asynchronous settings read returns the original messages', async () => {
  const runtime = createBackend()
  const read = deferred()
  runtime.setReader(() => read.promise)
  const messages = imageMessages()
  const pending = runtime.invoke('alice', messages)
  runtime.setPermission(false)
  read.resolve({ removeImageTagsFromContext: true })
  assert.strictEqual(await pending, messages)
  assert.equal(runtime.registrations[0].disposeCount, 1)
})

test('regrant while an old settings read is pending cannot reactivate the disposed callback', async () => {
  const runtime = createBackend()
  const read = deferred()
  runtime.setReader(() => read.promise)
  const messages = imageMessages()
  const pending = runtime.invoke('alice', messages)
  runtime.setPermission(false)
  runtime.setPermission(true)
  read.resolve({ removeImageTagsFromContext: true })
  assert.strictEqual(await pending, messages)
  runtime.setReader(async () => ({ removeImageTagsFromContext: true }))
  assert.equal((await runtime.invoke('alice', messages))[0].content, 'before after')
})

test('registration denial disposes the local handler even if the permission cache is stale', async () => {
  const runtime = createBackend()
  const deniedRegistration = runtime.active
  runtime.denyRegistration()
  assert.equal(deniedRegistration.disposeCount, 1)
  assert.equal(runtime.active, null)
  const messages = imageMessages()
  assert.strictEqual(await deniedRegistration.handler(messages, { userId: 'alice' }), messages)
  assert.equal(runtime.reads.length, 0)
  runtime.setPermission(true)
  assert.equal(runtime.registrations.length, 2)
  assert.equal((await runtime.invoke('alice', messages))[0].content, 'before after')
})
