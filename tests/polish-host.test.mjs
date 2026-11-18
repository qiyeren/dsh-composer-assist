import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { apply } from '../index.js'

// Every invocation uses a private temporary DSH_HOME and an in-memory model.
// The only exercised entry point is the route registered by the real apply(ctx).
async function fixture(t, { settings, chunks, session: sessionOverrides, services = {} } = {}) {
  const tempRoot = resolve(await realpath(tmpdir()))
  const prefix = 'dsh-polish-host-'
  const home = await mkdtemp(join(tempRoot, prefix))
  const created = await lstat(home)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    // Refuse recursive deletion if the exact directory we created has moved,
    // become a symlink, or no longer resolves to a direct child of tmpdir.
    const actual = resolve(await realpath(home))
    const current = await lstat(home)
    if (!isAbsolute(home) || resolve(home) !== home || actual !== home
      || dirname(actual) !== tempRoot || !basename(actual).startsWith(prefix)
      || basename(actual).length <= prefix.length || !current.isDirectory()
      || current.isSymbolicLink() || current.dev !== created.dev || current.ino !== created.ino) {
      throw new Error('Refusing to delete an unverified test directory')
    }
    await rm(home, { recursive: true, force: true })
  })
  if (settings !== undefined) {
    await mkdir(join(home, 'composer-assist'), { recursive: true })
    await writeFile(join(home, 'composer-assist', 'settings.json'), JSON.stringify(settings))
  }

  const calls = []
  const session = {
    id: 'test-session',
    seq: 7,
    surface: { nodes: ['node-1'], replaceGeneration: 2, contentGeneration: 3 },
    deriveMessages: () => [],
    requestHeader: () => ({ config: { provider: 'session-provider', model: 'session-model' } }),
    ...sessionOverrides,
  }
  const routes = new Map()
  const ctx = {
    get: name => services[name],
    sessions: { get: id => id === session.id ? session : undefined },
    llm: {
      prepareCall: async (controls, signal, configure) => {
        const call = { controls, signal, options: null }
        calls.push(call)
        return {
          config: configure(controls, { reasoning: { efforts: [{ id: 'low' }] } }),
          stream: async function* (options) {
            call.options = options
            yield* chunks ?? [
              { type: 'text-delta', text: 'Rewritten draft' },
              { type: 'finish', reason: { kind: 'stop' } },
            ]
          },
        }
      },
    },
    connection: { fetch: { register: route => { routes.set(route.path, route.fetch); return () => {} } } },
    effect: fn => fn(),
    on: () => () => {},
    inject: (_names, fn) => fn(ctx),
  }
  apply(ctx)
  const suggest = async (overrides = {}, signal) => {
    const request = new Request('http://localhost/api/composer-assist/suggest', {
      method: 'POST',
      signal,
      body: JSON.stringify({ sessionId: session.id, kind: 'polish', draft: 'Draft', revision: 42, source: 'node-1:2:3', ...overrides }),
    })
    const response = await routes.get('/api/composer-assist/suggest')(request)
    return { status: response.status, body: await response.json() }
  }
  const postSettings = async patch => {
    const request = new Request('http://localhost/api/composer-assist/settings', { method: 'POST', body: JSON.stringify(patch) })
    const response = await routes.get('/api/composer-assist/settings')(request)
    return response.json()
  }
  return { calls, ctx, home, session, suggest, postSettings, routes }
}

test('disabled polish reports why and never contacts the model', async t => {
  const { calls, suggest } = await fixture(t, { settings: { enabled: false } })
  assert.deepEqual(await suggest(), {
    status: 200,
    body: { ok: true, text: '', reason: 'disabled', sessionId: 'test-session', source: 'node-1:2:3', revision: 42 },
  })
  assert.equal((await suggest({ draft: ' \n ' })).body.reason, 'disabled')
  assert.equal(calls.length, 0)
})

test('polish fails closed on damaged or invalid settings without contacting the model', async t => {
  const { calls, home, suggest } = await fixture(t)
  const dir = join(home, 'composer-assist')
  await mkdir(dir)
  for (const contents of ['{"enabled":fal', 'null', '[]', '17', '"invalid"']) {
    await writeFile(join(dir, 'settings.json'), contents)
    const { status, body } = await suggest()
    assert.equal(status, 200)
    assert.equal(body.ok, false, contents)
    assert.equal(typeof body.error, 'string')
    assert.equal(body.sessionId, 'test-session')
    assert.equal(body.source, 'node-1:2:3')
    assert.equal(body.revision, 42)
  }
  assert.equal(calls.length, 0)
})

test('polish waits behind already queued same-process settings writes', async t => {
  const { calls, suggest, postSettings } = await fixture(t, { settings: { enabled: true } })
  let completed = 0
  const writes = Array.from({ length: 20 }, (_, i) =>
    postSettings({ enabled: i !== 19 }).then(result => { completed++; return result }))
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(completed < writes.length, 'at least one write is still pending')
    const { body } = await suggest()
    assert.equal(body.reason, 'disabled')
    assert.equal(calls.length, 0)
  } finally {
    const results = await Promise.all(writes)
    assert.ok(results.every(result => result.ok))
  }
})

test('disconnect while polish waits for the settings queue prevents model dispatch', async t => {
  const { calls, suggest, postSettings } = await fixture(t, { settings: { enabled: true } })
  const controller = new AbortController()
  let completed = 0
  const writes = Array.from({ length: 40 }, () =>
    postSettings({ enabled: true }).then(result => { completed++; return result }))
  let pending
  try {
    await new Promise(resolve => setImmediate(resolve))
    pending = suggest({}, controller.signal)
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(completed < writes.length, 'settings writes are still queued')
    controller.abort()
    const { body } = await pending
    assert.equal(body.reason, 'stale-source')
    assert.equal(body.text, '')
    assert.equal(calls.length, 0)
  } finally {
    controller.abort()
    if (pending) await pending
    await Promise.all(writes)
  }
})

test('polish fails closed on settings I/O errors without changing complete behavior', async t => {
  const { calls, home, suggest } = await fixture(t)
  await mkdir(join(home, 'composer-assist', 'settings.json'), { recursive: true })
  const failed = await suggest()
  assert.equal(failed.body.ok, false)
  assert.equal(failed.body.error, '无法读取润色设置')
  assert.equal(calls.length, 0)
  const complete = await suggest({ kind: 'complete' })
  assert.equal(complete.body.text, 'Rewritten draft')
  assert.equal(calls.length, 1)
})

test('blank polish input reports empty-input without contacting the model', async t => {
  const { calls, suggest } = await fixture(t)
  for (const draft of ['', ' \t\n ']) {
    assert.deepEqual(await suggest({ draft }), {
      status: 200,
      body: { ok: true, text: '', reason: 'empty-input', sessionId: 'test-session', source: 'node-1:2:3', revision: 42 },
    })
  }
  assert.equal(calls.length, 0)
})

test('polish sends only its draft and system instructions without collecting context', async t => {
  let historyReads = 0
  let workspaceReads = 0
  const secretHistory = 'private-history-should-not-be-read'
  const secretFile = 'private-filename-should-not-be-read'
  const settings = {
    enabled: true, diagnostics: true, gitContext: true, learn: true,
    learnStats: { accepted: 4, dismissed: 4, acceptedChars: 40, dismissedChars: 400 },
  }
  const { calls, home, suggest } = await fixture(t, {
    settings,
    session: { deriveMessages: () => { historyReads++; return [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: secretHistory }] }] } },
    services: {
      workingDirectory: { get: () => { workspaceReads++; return 'test-dir' } },
      fs: { resolve: async () => { workspaceReads++; return 'test-dir' }, listDir: async () => { workspaceReads++; return [{ type: 'file', name: secretFile }] } },
      subprocess: { spawn: () => { workspaceReads++; throw new Error('unexpected git') } },
    },
  })
  const draft = '保留路径 src/example.js\nDo not change the API.'
  const result = await suggest({ draft })
  assert.deepEqual(result, {
    status: 200,
    body: { ok: true, text: 'Rewritten draft', sessionId: 'test-session', source: 'node-1:2:3', revision: 42 },
  })
  assert.equal(historyReads, 0)
  assert.equal(workspaceReads, 0)
  assert.equal(calls.length, 1)
  const { controls, options } = calls[0]
  assert.equal(controls.provider, 'session-provider')
  assert.equal(controls.model, 'session-model')
  assert.equal(options.sessionId, 'test-session')
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].role, 'user')
  assert.equal(options.messages[0].content[0].text, `The user's draft message:\n\n${draft}\n\nRewrite it.`)
  assert.equal(typeof options.system, 'string')
  assert.ok(!JSON.stringify(options.messages).includes(secretHistory))
  assert.ok(!JSON.stringify(options.messages).includes(secretFile))
  assert.ok(!JSON.stringify(options.messages).includes('tends to accept'))
  assert.deepEqual(JSON.parse(await readFile(join(home, 'composer-assist', 'settings.json'), 'utf8')), settings)
})

test('polish rejects partial text without one normal terminal stop', async t => {
  const chunks = []
  const { suggest } = await fixture(t, { chunks })
  const endings = [
    { type: 'finish', reason: { kind: 'error', failure: { message: 'fake error' } } },
    { type: 'finish', reason: { kind: 'aborted', failure: { message: 'fake abort' } } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
    { type: 'finish', reason: { kind: 'unknown-provider-reason' } },
    null,
  ]
  for (const ending of endings) {
    chunks.splice(0, chunks.length, { type: 'text-delta', text: 'INCOMPLETE DRAFT' }, ...(ending === null ? [] : [ending]))
    const result = await suggest()
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, false, `finish ${ending?.reason?.kind ?? 'missing'}`)
    assert.equal(typeof result.body.error, 'string')
    assert.equal(result.body.sessionId, 'test-session')
    assert.equal(result.body.source, 'node-1:2:3')
    assert.equal(result.body.revision, 42)
    assert.ok(!JSON.stringify(result.body).includes('INCOMPLETE DRAFT'))
  }
})

test('polish rejects a stream containing tool calls or chunks after finish', async t => {
  const chunks = []
  const { suggest } = await fixture(t, { chunks })
  const finish = { type: 'finish', reason: { kind: 'stop' } }
  for (const stream of [
    [{ type: 'tool-call-delta', id: 'fake', argumentsDelta: '{}' }, finish],
    [{ type: 'block-start', blockType: 'tool-call', index: 0 }, finish],
    [{ type: 'block-end', block: { type: 'tool-call' }, index: 0 }, finish],
    [finish, { type: 'text-delta', text: 'after finish' }],
    [finish, finish],
  ]) {
    chunks.splice(0, chunks.length, { type: 'text-delta', text: 'PARTIAL' }, ...stream)
    const { body } = await suggest()
    assert.equal(body.ok, false)
    assert.ok(!JSON.stringify(body).includes('PARTIAL'))
  }
})

test('polish assembles interleaved blocks in first-seen order using authoritative block-end', async t => {
  const chunks = []
  const { suggest } = await fixture(t, { chunks })
  const finish = { type: 'finish', reason: { kind: 'stop' } }
  chunks.push(
    { type: 'text-delta', index: 0, text: 'A' },
    { type: 'text-delta', index: 1, text: 'B' },
    { type: 'text-delta', index: 0, text: 'C' },
    { type: 'text-delta', index: 1, text: 'D' }, finish,
  )
  assert.equal((await suggest()).body.text, 'ACBD')
  chunks.splice(0, chunks.length,
    { type: 'block-start', index: 4, blockType: 'text' },
    { type: 'block-start', index: 2, blockType: 'text' },
    { type: 'text-delta', index: 2, text: 'SECOND' },
    { type: 'text-delta', index: 4, text: 'old' },
    { type: 'block-end', index: 4, block: { type: 'text', text: 'FIRST' } },
    { type: 'text-delta', index: 4, text: 'ignored' },
    { type: 'block-end', index: 4, block: { type: 'text', text: 'ignored duplicate' } },
    finish,
  )
  assert.equal((await suggest()).body.text, 'FIRSTSECOND')
})

test('polish preserves model output including literal quotes, fences and whitespace', async t => {
  const chunks = []
  const { suggest } = await fixture(t, { chunks })
  for (const text of ['"a complete quotation"', '```js\nconst value = 1\n```', '\n  exact leading and trailing whitespace  \n']) {
    chunks.splice(0, chunks.length,
      { type: 'text-delta', text },
      { type: 'finish', reason: { kind: 'stop' } })
    assert.equal((await suggest()).body.text, text)
  }
})

test('an already disconnected polish request never contacts the model', async t => {
  const { calls, suggest } = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  const { body } = await suggest({}, controller.signal)
  assert.equal(body.reason, 'stale-source')
  assert.equal(body.text, '')
  assert.equal(calls.length, 0)
})

test('polish removes its request abort listener on success and settings failure', async t => {
  const { home, routes } = await fixture(t)
  const invoke = async () => {
    const controller = new AbortController()
    const request = new Request('http://localhost/api/composer-assist/suggest', {
      method: 'POST', signal: controller.signal,
      body: JSON.stringify({ sessionId: 'test-session', kind: 'polish', draft: 'Draft', revision: 1 }),
    })
    const before = getEventListeners(request.signal, 'abort').length
    const response = await routes.get('/api/composer-assist/suggest')(request)
    assert.equal(getEventListeners(request.signal, 'abort').length, before)
    return response.json()
  }
  assert.equal((await invoke()).ok, true)
  await mkdir(join(home, 'composer-assist', 'settings.json'), { recursive: true })
  assert.equal((await invoke()).ok, false)
})

test('disconnect aborts polish and the next request waits for the owned call to drain', async t => {
  let release, signalStarted, invocation = 0
  const started = new Promise(resolve => { signalStarted = resolve })
  const chunks = {
    async *[Symbol.asyncIterator]() {
      if (invocation++ === 0) {
        yield { type: 'text-delta', text: 'PARTIAL' }
        signalStarted()
        await new Promise(resolve => { release = resolve })
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else {
        yield { type: 'text-delta', text: 'SECOND' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    },
  }
  const { calls, suggest } = await fixture(t, { chunks, settings: { timeoutMs: 2000 } })
  const controller = new AbortController()
  let second
  try {
    const first = suggest({}, controller.signal)
    await started
    controller.abort()
    const response = await first
    assert.equal(response.body.reason, 'stale-source')
    assert.equal(response.body.text, '')
    assert.equal(calls[0].signal.aborted, true)
    second = suggest({ revision: 43 })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.length, 1)
    release()
    release = undefined
    assert.equal((await second).body.text, 'SECOND')
    assert.equal(calls.length, 2)
  } finally {
    release?.()
    if (second) await second
    await new Promise(resolve => setImmediate(resolve))
  }
})

test('polish waiting for an old call does not dispatch after the plugin is disabled', async t => {
  let release, signalStarted, invocation = 0
  const started = new Promise(resolve => { signalStarted = resolve })
  const chunks = {
    async *[Symbol.asyncIterator]() {
      if (invocation++ === 0) {
        yield { type: 'text-delta', text: 'OLD' }
        signalStarted()
        await new Promise(resolve => { release = resolve })
      } else {
        yield { type: 'text-delta', text: 'SHOULD NOT DISPATCH' }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { calls, suggest, postSettings } = await fixture(t, { settings: { enabled: true }, chunks })
  let first, second
  try {
    first = suggest({ revision: 1 })
    await started
    second = suggest({ revision: 2 })
    assert.equal((await first).body.reason, 'stale-source')
    // A queued settings write is a public-route barrier: B has passed its
    // initial queued settings read before this write can complete.
    assert.equal((await postSettings({})).ok, true)
    assert.equal(calls.length, 1)
    assert.equal((await postSettings({ enabled: false })).ok, true)
    release()
    release = undefined
    const { body } = await second
    assert.equal(body.reason, 'disabled')
    assert.equal(body.text, '')
    assert.equal(body.revision, 2)
    assert.equal(calls.length, 1)
  } finally {
    release?.()
    if (first) await first
    if (second) await second
  }
})

test('polish rechecks damaged settings after an old call drains', async t => {
  let release, signalStarted, invocation = 0
  const started = new Promise(resolve => { signalStarted = resolve })
  const chunks = {
    async *[Symbol.asyncIterator]() {
      if (invocation++ === 0) {
        yield { type: 'text-delta', text: 'OLD' }
        signalStarted()
        await new Promise(resolve => { release = resolve })
      } else yield { type: 'text-delta', text: 'SHOULD NOT DISPATCH' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { calls, home, suggest, postSettings } = await fixture(t, { settings: { enabled: true }, chunks })
  let first, second
  try {
    first = suggest({ revision: 1 })
    await started
    second = suggest({ revision: 2 })
    assert.equal((await first).body.reason, 'stale-source')
    assert.equal((await postSettings({})).ok, true)
    await writeFile(join(home, 'composer-assist', 'settings.json'), '{"enabled":')
    release()
    release = undefined
    const { body } = await second
    assert.equal(body.ok, false)
    assert.equal(body.error, '无法读取润色设置')
    assert.equal(body.revision, 2)
    assert.equal(calls.length, 1)
  } finally {
    release?.()
    if (first) await first
    if (second) await second
  }
})

test('cancelled polish waiting for an old call does not dispatch', async t => {
  let release, signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const chunks = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: 'OLD' }
      signalStarted()
      await new Promise(resolve => { release = resolve })
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { calls, suggest, postSettings } = await fixture(t, { settings: { enabled: true }, chunks })
  const controller = new AbortController()
  let first, second
  try {
    first = suggest({ revision: 1 })
    await started
    second = suggest({ revision: 2 }, controller.signal)
    assert.equal((await first).body.reason, 'stale-source')
    assert.equal((await postSettings({})).ok, true)
    controller.abort()
    assert.equal((await second).body.reason, 'stale-source')
    assert.equal(calls.length, 1)
  } finally {
    controller.abort()
    release?.()
    if (first) await first
    if (second) await second
    await new Promise(resolve => setImmediate(resolve))
  }
})

test('polish waiting for an old call keeps its original timeout', async t => {
  let release, signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const chunks = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: 'OLD' }
      signalStarted()
      await new Promise(resolve => { release = resolve })
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { calls, suggest, postSettings } = await fixture(t, { settings: { enabled: true, timeoutMs: 2000 }, chunks })
  let first, second
  try {
    first = suggest({ revision: 1 })
    await started
    second = suggest({ revision: 2 })
    assert.equal((await first).body.reason, 'stale-source')
    assert.equal((await postSettings({})).ok, true)
    assert.equal((await second).body.reason, 'timeout')
    assert.equal(calls.length, 1)
  } finally {
    release?.()
    if (first) await first
    if (second) await second
    await new Promise(resolve => setImmediate(resolve))
  }
})

test('polish timeout discards partial output even when the fake provider ignores cancellation', async t => {
  let release
  const chunks = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: 'PARTIAL BEFORE TIMEOUT' }
      await new Promise(resolve => { release = resolve })
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { calls, suggest } = await fixture(t, { settings: { timeoutMs: 2000 }, chunks })
  try {
    const { status, body } = await suggest()
    assert.equal(status, 200)
    assert.deepEqual(body, { ok: true, text: '', reason: 'timeout', sessionId: 'test-session', source: 'node-1:2:3', revision: 42 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].signal.aborted, true)
  } finally {
    release?.()
    await new Promise(resolve => setImmediate(resolve))
  }
})

test('legacy settings retain manual polish and use configured or fallback routes', async t => {
  const oldSettings = { mode: 'off', display: 'card', provider: 'legacy-provider', model: 'legacy-model' }
  const { calls, home, session, suggest } = await fixture(t, {
    settings: oldSettings,
    services: { agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) } },
  })
  assert.equal((await suggest()).body.text, 'Rewritten draft')
  assert.equal(calls[0].controls.provider, 'legacy-provider')
  assert.equal(calls[0].controls.model, 'legacy-model')
  assert.deepEqual(JSON.parse(await readFile(join(home, 'composer-assist', 'settings.json'), 'utf8')), oldSettings)
  await writeFile(join(home, 'composer-assist', 'settings.json'), '{}')
  session.requestHeader = () => undefined
  assert.equal((await suggest()).body.text, 'Rewritten draft')
  assert.equal(calls[1].controls.provider, 'default-provider')
  assert.equal(calls[1].controls.model, 'default-model')
})

test('existing next and complete keep context, cleaning and non-polish stream behavior', async t => {
  const chunks = [{ type: 'text-delta', text: '1. Resume the work\nCONFIDENCE: 0.7' }]
  const { calls, suggest } = await fixture(t, {
    settings: {
      enabled: false, learn: true,
      learnStats: { accepted: 4, dismissed: 4, acceptedChars: 40, dismissedChars: 400 },
    },
    chunks,
    session: { deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'past request' }] }] },
    services: {
      workingDirectory: { get: () => 'test-dir' },
      fs: { resolve: async () => 'test-dir', listDir: async () => [{ type: 'file', name: 'workspace.js' }] },
    },
  })
  const next = await suggest({ kind: 'next', draft: '' })
  assert.equal(next.body.text, 'Resume the work')
  assert.equal(next.body.confidence, 0.7)
  assert.ok(calls[0].options.messages[0].content[0].text.includes('past request'))
  assert.ok(calls[0].options.messages[0].content[0].text.includes('workspace.js'))
  assert.ok(calls[0].options.messages[0].content[0].text.includes('tends to accept shorter'))
  chunks.splice(0, chunks.length, { type: 'text-delta', text: '```\ncontinued\n```' })
  const complete = await suggest({ kind: 'complete' })
  assert.equal(complete.body.text, 'continued')
  assert.ok(calls[1].options.messages[0].content[0].text.includes('past request'))
  assert.ok(calls[1].options.messages[0].content[0].text.includes('workspace.js'))
})

test('stale source is discarded before and during a polish call', async t => {
  let release, signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const chunks = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: 'NOT CURRENT' }
      signalStarted()
      await new Promise(resolve => { release = resolve })
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { calls, session, suggest } = await fixture(t, { chunks })
  const rejected = await suggest({ source: 'stale' })
  assert.equal(rejected.body.reason, 'stale-source')
  assert.equal(calls.length, 0)
  const running = suggest()
  await started
  session.surface.contentGeneration++
  release()
  const { body } = await running
  assert.deepEqual(body, { ok: true, text: '', reason: 'stale-source', sessionId: 'test-session', source: 'node-1:2:3', revision: 42 })
})

test('a normal but empty polish output is model-empty; missing finish is failure', async t => {
  const chunks = []
  const { suggest } = await fixture(t, { chunks })
  assert.equal((await suggest()).body.ok, false)
  for (const text of ['', ' \t\n ']) {
    chunks.splice(0, chunks.length,
      { type: 'text-delta', text },
      { type: 'finish', reason: { kind: 'stop' } })
    const { body } = await suggest()
    assert.equal(body.ok, true)
    assert.equal(body.reason, 'model-empty')
    assert.equal(body.text, '')
    assert.equal(body.transcriptChars, 0)
  }
})
