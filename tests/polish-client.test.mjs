// Behavioral tests at the registered slot/user-action boundary. These use a
// minimal hook harness, not a browser, desktop, layout, or accessibility audit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))

function deferred() {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function harness(options = {}) {
  const slots = new Map(), calls = [], writes = [], storageWrites = []
  const input = { draft: '原始草稿', draftRev: 1, phase: 'plain', attachmentIds: [], ...options.input }
  const clipboard = Object.hasOwn(options, 'clipboard') ? options.clipboard : { writeText: async text => { writes.push(text) } }
  let pending = null, dictionaries, currentRunner
  const timers = new Map(); let timerId = 0
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity).filter(v => v !== null && v !== false && v !== undefined) } },
    useRef(value) { return currentRunner.hook('ref', value) },
    useState(value) { return currentRunner.hook('state', value) },
    useEffect(effect, deps) { return currentRunner.effect(effect, deps) },
  }
  const sessionStorage = {
    getItem: () => null,
    setItem: (key, value) => { storageWrites.push([key, value]) },
    removeItem: () => {},
  }
  const fetch = async (url, init = {}) => {
    const pathname = String(url)
    calls.push({ url: pathname, init })
    if (pathname.endsWith('/settings')) return { json: async () => ({ settings: { enabled: true, mode: 'off', timeoutMs: 2000 } }) }
    if (pathname.includes('/suggest')) {
      const body = JSON.parse(init.body)
      if (options.defer === true || (typeof options.defer === 'function' && options.defer(body))) {
        pending = deferred(); pending.body = body; return pending.promise
      }
      const response = options.response?.(body) ?? { ok: true, text: '润色后的结果', sessionId: body.sessionId, revision: body.revision, source: 'turn-1' }
      return { json: async () => response }
    }
    if (pathname.includes('/turn?')) return { json: async () => ({ ok: true, source: 'turn-1', turn: null }) }
    throw new Error(`unexpected request ${pathname}`)
  }
  const window = { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load(spec) { window.plugin = spec.factory(name => {
    assert.equal(name, 'react'); return React
  }) } } }
  const context = vm.createContext({ window, sessionStorage, fetch, navigator: { clipboard }, AbortController, DOMException, console,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id },
    clearTimeout(id) { timers.delete(id) }, setInterval() { return ++timerId }, clearInterval() {},
  })
  vm.runInContext(client, context)
  const ctx = {
    effect(fn) { fn() },
    locale: { register(_ns, values) { dictionaries = values }, bind() { return key => dictionaries.zh[key] ?? key } },
    slots: { inject(_name, fn) { fn() }, register(info, component) { slots.set(info.id, component); slots.set(`${info.name}:${info.id}`, component) } },
    shortcuts: { observeFixedInput() {} }, remote: { session: {} },
  }
  window.plugin.apply(ctx)
  const setDraftCalls = []
  const inputActions = { setDraft: text => { setDraftCalls.push(text) }, submit: () => assert.fail('must not submit') }
  if (!options.noCapture) inputActions.captureInsertion = () => {
    if (options.captureError) throw new Error('no capture available')
    return { start: 0, end: 0, draftRev: input.draftRev }
  }
  const props = { sessionId: 'session-a', useInput: selector => selector(input),
    useSession: selector => selector({ blank: false, running: false }), inputActions,
    t: key => dictionaries.zh[key] ?? key }
  class Runner {
    constructor(component, componentProps) { this.component = component; this.componentProps = componentProps; this.hooks = []; this.index = 0; this.pendingEffects = []; this.dirty = true; this.dead = false }
    hook(kind, initial) {
      const index = this.index++
      if (!this.hooks[index]) this.hooks[index] = kind === 'ref' ? { kind, value: { current: initial } } : { kind, value: initial }
      const cell = this.hooks[index]
      if (kind === 'ref') return cell.value
      return [cell.value, next => { if (this.dead) return; cell.value = typeof next === 'function' ? next(cell.value) : next; this.dirty = true }]
    }
    effect(fn, deps) {
      const index = this.index++, old = this.hooks[index]
      const changed = !old || !deps || !old.deps || deps.length !== old.deps.length || deps.some((v, i) => !Object.is(v, old.deps[i]))
      if (changed) this.pendingEffects.push(() => { old?.cleanup?.(); this.hooks[index] = { deps, cleanup: fn() } })
    }
    render() {
      if (this.dead) return
      this.index = 0; this.pendingEffects = []; this.dirty = false; currentRunner = this
      this.tree = this.component(this.componentProps ?? props); currentRunner = undefined
      for (const effect of this.pendingEffects) effect()
    }
    unmount() { this.dead = true; for (const cell of this.hooks) cell?.cleanup?.() }
  }
  const runners = []
  async function flush() {
    for (let i = 0; i < 10; i++) {
      await tick()
      let dirty = false
      for (const r of runners) if (r.dirty) { r.render(); dirty = true }
      if (!dirty && i > 2) break
    }
  }
  function mount(id) { const component = slots.get(id); if (!component) return undefined; const runner = new Runner(component); runners.push(runner); runner.render(); return runner }
  function mountChild(wrapper) { const runner = new Runner(wrapper.tree.type, wrapper.tree.props); runners.push(runner); runner.render(); return runner }
  function update(patch, sessionId = props.sessionId) { Object.assign(input, patch); props.sessionId = sessionId; for (const r of runners) r.dirty = true }
  function nodes() {
    const all = []
    const visit = node => { if (!node || typeof node !== 'object') return; all.push(node); for (const child of node.children ?? []) visit(child) }
    for (const runner of runners) if (!runner.dead) visit(runner.tree)
    return all
  }
  const text = () => nodes().flatMap(n => [...(n.children ?? []), ...(n.type === 'textarea' ? [n.props.value] : [])]).filter(v => typeof v === 'string').join(' ')
  const button = label => nodes().find(n => n.type === 'button' && ((n.props['aria-label'] ?? '') === label || (n.children ?? []).includes(label)))
  return { input, props, calls, writes, storageWrites, slots, runners, mount, mountChild, flush, update, nodes, text, button, setDraftCalls, timers, get pending() { return pending } }
}

test('点击润色只请求一次，展示原稿和结果而不写入草稿或剪贴板', async () => {
  const ui = harness()
  await ui.flush()
  ui.mount('composer-assist-polish-preview')
  ui.mount('composer-assist-polish')
  await ui.flush()
  const trigger = ui.button('润色提示词')
  assert.ok(trigger, '润色按钮可见')
  trigger.props.onClick()
  await ui.flush()
  assert.equal(ui.calls.filter(call => call.url.endsWith('/suggest')).length, 1)
  assert.deepEqual(ui.setDraftCalls, [])
  assert.deepEqual(ui.writes, [])
  assert.match(ui.text(), /原始草稿/)
  assert.match(ui.text(), /润色后的结果/)
  assert.ok(ui.button('复制结果'))
  assert.ok(ui.button('关闭'))
})

test('预览明确说明纯文本和附件、引用结构的风险', async () => {
  const ui = harness({ defer: true })
  await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
  ui.button('润色提示词').props.onClick(); await ui.flush()
  assert.match(ui.text(), /预览与复制都是纯文本/)
  assert.match(ui.text(), /附件内容.*引用的语义结构.*不参与润色/)
  assert.match(ui.text(), /手动粘贴替换可能丢失结构/)
  assert.match(ui.text(), /原稿未更改/)
})

test('预览晚于按钮挂载时，按钮仍能使用当前已就绪的通道', async () => {
  const ui = harness()
  await ui.flush(); ui.mount('composer-assist-polish')
  const trigger = ui.button('润色提示词')
  ui.mount('composer-assist-polish-preview')
  trigger.props.onClick(); await ui.flush()
  assert.equal(ui.calls.filter(call => call.url.endsWith('/suggest')).length, 1)
  assert.match(ui.text(), /润色后的结果/)
})

test('同会话多个预览或按钮无法确认归属时阻止调用，唯一实例恢复后可用', async () => {
  for (const duplicate of ['composer-assist-polish-preview', 'composer-assist-polish']) {
    const ui = harness()
    await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
    const extra = ui.mount(duplicate); await ui.flush()
    ui.button('润色提示词').props.onClick(); await ui.flush()
    assert.equal(ui.calls.filter(call => call.url.endsWith('/suggest')).length, 0)
    assert.match(ui.text(), /多个.*关闭.*重复/)
    extra.unmount(); await ui.flush()
    assert.doesNotMatch(ui.text(), /多个输入视图|暂不可用/)
    ui.button('润色提示词').props.onClick(); await ui.flush()
    assert.equal(ui.calls.filter(call => call.url.endsWith('/suggest')).length, 1)
    assert.match(ui.text(), /润色后的结果/)
  }
})

test('已有请求遇到重复预览时作废，不跨视图出现结果', async () => {
  const ui = harness({ defer: true })
  await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
  ui.button('润色提示词').props.onClick(); await ui.flush()
  const pending = ui.pending
  const extra = ui.mount('composer-assist-polish-preview'); await ui.flush()
  pending.resolve({ json: async () => ({ ok: true, text: '不应显示的结果', sessionId: pending.body.sessionId,
    revision: pending.body.revision, source: 'turn-1' }) })
  await ui.flush()
  assert.doesNotMatch(ui.text(), /不应显示的结果/)
  extra.unmount(); await ui.flush()
  assert.equal(ui.button('复制结果'), undefined)
})

test('润色结果通过有名称的可聚焦只读文本框提供键盘手动复制', async () => {
  const ui = harness({ clipboard: undefined })
  await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
  ui.button('润色提示词').props.onClick(); await ui.flush()
  let result = ui.nodes().find(node => node.type === 'textarea' && node.props['aria-label'] === '润色结果')
  assert.ok(result, '结果应是具名 textarea')
  assert.equal(result.props.readOnly, true)
  assert.notEqual(result.props.disabled, true)
  assert.ok(result.props.tabIndex === undefined || result.props.tabIndex >= 0)
  assert.equal(result.props.value, '润色后的结果')
  ui.button('复制结果').props.onClick(); await ui.flush()
  result = ui.nodes().find(node => node.type === 'textarea' && node.props['aria-label'] === '润色结果')
  assert.equal(result.props.value, '润色后的结果')
  assert.match(ui.text(), /手动复制/)
})

test('未知空结果原因安全回退为一般失败，不暴露原始错误文本', async () => {
  const ui = harness({ response: body => ({ ok: true, text: '', reason: 'secret-provider-reason',
    sessionId: body.sessionId, revision: body.revision, source: 'turn-1' }) })
  await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
  ui.button('润色提示词').props.onClick(); await ui.flush()
  assert.match(ui.text(), /润色失败/)
  assert.doesNotMatch(ui.text(), /secret-provider-reason/)
  assert.ok(ui.button('重试'))
  assert.deepEqual(ui.setDraftCalls, [])
})

test('用户手动复制时保留模型原始空白和围栏，不读取剪贴板或写回草稿', async () => {
  const output = '  ```text\n原样结果\n```\n  '
  const ui = harness({ response: body => ({ ok: true, text: output, candidates: ['不应替代原始文本'],
    sessionId: body.sessionId, revision: body.revision, source: 'turn-1' }) })
  await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
  ui.button('润色提示词').props.onClick(); await ui.flush()
  assert.ok(ui.nodes().some(node => node.type === 'textarea' && node.props.value === output))
  assert.deepEqual(ui.writes, [])
  ui.button('复制结果').props.onClick(); await ui.flush()
  assert.deepEqual(ui.writes, [output])
  assert.match(ui.text(), /已复制结果，草稿未更改/)
  assert.deepEqual(ui.setDraftCalls, [])
  assert.ok(ui.storageWrites.every(([, value]) => !value.includes(output) && !value.includes('原始草稿')))
})

test('编辑器 revision 尚未触发渲染时，请求、响应、按钮和手动复制均安全拒绝', async () => {
  for (const stage of ['request', 'response', 'button-copy', 'manual-copy', 'missing-api']) {
    const ui = harness({ defer: stage === 'response', noCapture: stage === 'missing-api' })
    await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
    if (stage === 'request') ui.input.draftRev = 2
    ui.button('润色提示词').props.onClick(); await ui.flush()
    if (stage === 'request' || stage === 'missing-api') {
      assert.equal(ui.calls.filter(call => call.url.endsWith('/suggest')).length, 0)
      assert.match(ui.text(), stage === 'missing-api' ? /无法验证/ : /已变化/)
      continue
    }
    if (stage === 'response') {
      const pending = ui.pending
      ui.input.draftRev = 2
      pending.resolve({ json: async () => ({ ok: true, text: '迟到结果', sessionId: pending.body.sessionId,
        revision: pending.body.revision, source: 'turn-1' }) })
      await ui.flush()
      assert.doesNotMatch(ui.text(), /迟到结果/)
      assert.match(ui.text(), /已变化/)
      continue
    }
    ui.input.draftRev = 2
    if (stage === 'button-copy') ui.button('复制结果').props.onClick()
    else {
      const result = ui.nodes().find(node => node.type === 'textarea')
      let prevented = false
      assert.equal(typeof result.props.onCopy, 'function')
      result.props.onCopy({ preventDefault: () => { prevented = true } })
      assert.equal(prevented, true)
    }
    await ui.flush()
    assert.deepEqual(ui.writes, [])
    assert.equal(ui.nodes().some(node => node.type === 'textarea'), false)
    assert.match(ui.text(), /已变化/)
  }
})

test('进行中发生会话、版本、阶段或附件顺序变化，旧结果不会复活', async () => {
  const changes = [
    { patch: {}, session: 'session-b' },
    { patch: { draftRev: 2 } },
    { patch: { phase: 'sending' } },
    { patch: { attachmentIds: ['b', 'a'] } },
  ]
  for (const { patch, session } of changes) {
    const ui = harness({ defer: true, input: { attachmentIds: ['a', 'b'] } })
    await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
    ui.button('润色提示词').props.onClick(); await ui.flush()
    const pending = ui.pending
    assert.ok(pending)
    ui.update(patch, session ?? 'session-a'); await ui.flush()
    pending.resolve({ json: async () => ({ ok: true, text: '旧结果', sessionId: pending.body.sessionId,
      revision: pending.body.revision, source: 'turn-1' }) })
    await ui.flush()
    assert.doesNotMatch(ui.text(), /旧结果|原始草稿/)
    assert.equal(ui.button('复制结果'), undefined)
    ui.update({ draftRev: 1, phase: 'plain', attachmentIds: ['a', 'b'] }, 'session-a'); await ui.flush()
    assert.doesNotMatch(ui.text(), /旧结果|原始草稿/)
    assert.equal(ui.button('复制结果'), undefined)
    assert.deepEqual(ui.writes, [])
    assert.deepEqual(ui.setDraftCalls, [])
  }
})

test('已展示的结果在版本或附件改变后立刻不可复制', async () => {
  for (const patch of [{ draftRev: 2 }, { attachmentIds: ['b', 'a'] }, { phase: 'sending' }]) {
    const ui = harness({ input: { attachmentIds: ['a', 'b'] } })
    await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
    ui.button('润色提示词').props.onClick(); await ui.flush()
    assert.ok(ui.button('复制结果'))
    ui.update(patch); await ui.flush()
    assert.equal(ui.button('复制结果'), undefined)
    assert.doesNotMatch(ui.text(), /润色后的结果|原始草稿/)
    assert.match(ui.text(), /已变化/)
  }
})

test('缺少宿主修订号或有序附件 ID 时安全停用，不发请求、不改草稿', async () => {
  for (const patch of [{ draftRev: undefined }, { attachmentIds: undefined }]) {
    const ui = harness({ input: patch })
    await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
    ui.button('润色提示词').props.onClick(); await ui.flush()
    assert.match(ui.text(), /无法验证草稿变化/)
    assert.equal(ui.calls.filter(call => call.url.endsWith('/suggest')).length, 0)
    assert.deepEqual(ui.setDraftCalls, [])
    assert.equal(ui.input.draft, '原始草稿')
  }
})

test('服务返回的禁用、超时、空结果、过期和失败各有明确提示且可重试', async () => {
  const cases = [
    { reason: 'disabled', match: /已禁用/ },
    { reason: 'timeout', match: /超时/ },
    { reason: 'empty-input', match: /草稿为空/ },
    { reason: 'model-empty', match: /没有返回润色结果/ },
    { reason: 'stale-source', match: /已变化/ },
    { failed: true, match: /润色失败/ },
  ]
  for (const scenario of cases) {
    let attempts = 0
    const ui = harness({ response: body => {
      attempts++
      const base = { sessionId: body.sessionId, revision: body.revision, source: 'turn-1' }
      if (attempts > 1) return { ...base, ok: true, text: '重试成功' }
      return scenario.failed ? { ...base, ok: false, error: 'private model failure' }
        : { ...base, ok: true, text: '', reason: scenario.reason }
    } })
    await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
    ui.button('润色提示词').props.onClick(); await ui.flush()
    assert.match(ui.text(), scenario.match)
    assert.doesNotMatch(ui.text(), /private model failure/)
    assert.ok(ui.button('重试'))
    ui.button('重试').props.onClick(); await ui.flush()
    assert.match(ui.text(), /重试成功/)
    assert.equal(ui.calls.filter(call => call.url.endsWith('/suggest')).length, 2)
    assert.deepEqual(ui.setDraftCalls, [])
  }
})

test('关闭预测条不会取消同会话正在进行的润色', async () => {
  const ui = harness({ defer: body => body.kind === 'polish', response: body => ({
    ok: true, text: '预测结果', sessionId: body.sessionId, revision: body.revision, source: 'turn-1',
  }) })
  await ui.flush()
  const wrapper = ui.mount('conversation.input.dock:composer-assist'); ui.mountChild(wrapper)
  ui.mount('composer-assist-predict'); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish')
  await ui.flush()
  ui.button('预测输入框').props.onClick(); await ui.flush()
  assert.ok(ui.button('忽略'), '预测条显示后可关闭')
  ui.button('润色提示词').props.onClick(); await ui.flush()
  const pending = ui.pending
  ui.button('忽略').props.onClick(); await ui.flush()
  pending.resolve({ json: async () => ({ ok: true, text: '独立润色结果', sessionId: pending.body.sessionId,
    revision: pending.body.revision, source: 'turn-1' }) })
  await ui.flush()
  assert.match(ui.text(), /独立润色结果/)
  assert.ok(ui.button('复制结果'))
  assert.deepEqual(ui.setDraftCalls, [])
})

test('客户端超时后提示重试并忽略迟到结果', async () => {
  const ui = harness({ defer: true })
  await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
  ui.button('润色提示词').props.onClick(); await ui.flush()
  const pending = ui.pending
  const timer = [...ui.timers.values()].find(item => item.ms === 3000)
  assert.ok(timer, '设置了有界超时'); timer.fn(); await ui.flush()
  assert.match(ui.text(), /超时/)
  assert.ok(ui.button('重试'))
  pending.resolve({ json: async () => ({ ok: true, text: '超时后旧结果', sessionId: pending.body.sessionId,
    revision: pending.body.revision, source: 'turn-1' }) })
  await ui.flush()
  assert.doesNotMatch(ui.text(), /超时后旧结果/)
})

test('双击只触发一次调用，关闭或卸载后旧响应不能重新出现', async () => {
  for (const closeMode of ['close', 'unmount']) {
    const ui = harness({ defer: true })
    await ui.flush(); const panel = ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
    const trigger = ui.button('润色提示词')
    trigger.props.onClick(); trigger.props.onClick(); await ui.flush()
    assert.equal(ui.calls.filter(call => call.url.endsWith('/suggest')).length, 1)
    const pending = ui.pending
    if (closeMode === 'close') ui.button('关闭').props.onClick()
    else panel.unmount()
    await ui.flush()
    pending.resolve({ json: async () => ({ ok: true, text: '关闭后的结果', sessionId: pending.body.sessionId,
      revision: pending.body.revision, source: 'turn-1' }) })
    await ui.flush()
    assert.doesNotMatch(ui.text(), /关闭后的结果|原始草稿/)
    assert.equal(ui.button('复制结果'), undefined)
    assert.deepEqual(ui.setDraftCalls, [])
  }
})

test('忙碌、空稿及非 plain 阶段均保留可聚焦触发按钮并拒绝触发', async () => {
  for (const patch of [null, { draft: '', draftRev: 2 }, { phase: 'sending' }]) {
    const ui = harness({ defer: true })
    await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
    ui.button('润色提示词').props.onClick(); await ui.flush()
    if (patch) { ui.update(patch); await ui.flush() }
    const trigger = ui.button('润色提示词')
    assert.notEqual(trigger.props.disabled, true, '焦点回收目标不可原生禁用')
    assert.equal(trigger.props['aria-disabled'], true)
    trigger.props.onClick(); await ui.flush()
    assert.equal(ui.calls.filter(call => call.url.endsWith('/suggest')).length, 1)
    ui.button('关闭').props.onClick(); await ui.flush()
  }
})

test('无草稿或提交中不能无反馈重试，恢复后可重试', async () => {
  for (const { blocked, restored, hint } of [
    { blocked: { draft: '', draftRev: 2 }, restored: { draft: '新草稿', draftRev: 3 }, hint: /请先填写草稿/ },
    { blocked: { phase: 'sending' }, restored: { phase: 'plain' }, hint: /请等待当前操作完成/ },
  ]) {
    let attempts = 0
    const ui = harness({ response: body => {
      attempts++
      return { ok: true, text: attempts === 1 ? '' : '重新润色成功', reason: attempts === 1 ? 'model-empty' : undefined,
        sessionId: body.sessionId, revision: body.revision, source: 'turn-1' }
    } })
    await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
    ui.button('润色提示词').props.onClick(); await ui.flush()
    ui.update(blocked); await ui.flush()
    assert.equal(ui.button('重试').props.disabled, true)
    assert.match(ui.text(), hint)
    ui.button('重试').props.onClick(); await ui.flush()
    assert.equal(attempts, 1)
    ui.update(restored); await ui.flush()
    assert.notEqual(ui.button('重试').props.disabled, true)
    ui.button('重试').props.onClick(); await ui.flush()
    assert.equal(attempts, 2)
    assert.match(ui.text(), /重新润色成功/)
  }
})

test('工具按钮卸载时清除预览并取消其尚未完成的请求', async () => {
  const ui = harness({ defer: true })
  await ui.flush(); ui.mount('composer-assist-polish-preview'); const trigger = ui.mount('composer-assist-polish'); await ui.flush()
  ui.button('润色提示词').props.onClick(); await ui.flush()
  const pending = ui.pending
  trigger.unmount(); await ui.flush()
  pending.resolve({ json: async () => ({ ok: true, text: '卸载后的结果', sessionId: pending.body.sessionId,
    revision: pending.body.revision, source: 'turn-1' }) })
  await ui.flush()
  assert.doesNotMatch(ui.text(), /卸载后的结果|原始草稿/)
  assert.equal(ui.button('复制结果'), undefined)
})

test('预览区域可使用 Escape 关闭并将焦点交还润色按钮', async () => {
  const ui = harness()
  await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
  const trigger = ui.button('润色提示词')
  let focused = 0
  trigger.props.ref.current = { focus: () => { focused++ } }
  trigger.props.onClick(); await ui.flush()
  const region = ui.nodes().find(node => node.props.role === 'region' && node.props['aria-label'] === '润色预览')
  assert.ok(region)
  let prevented = false, stopped = false
  region.props.onKeyDown({ key: 'Escape', preventDefault: () => { prevented = true }, stopPropagation: () => { stopped = true } })
  await ui.flush()
  assert.equal(prevented, true); assert.equal(stopped, true); assert.equal(focused, 1)
  assert.equal(ui.button('复制结果'), undefined)
  assert.doesNotMatch(ui.text(), /原始草稿|润色后的结果/)
})

test('关闭后迟到的剪贴板回应不会恢复预览', async () => {
  const copy = deferred(), writes = []
  const ui = harness({ clipboard: { writeText: text => { writes.push(text); return copy.promise } } })
  await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
  ui.button('润色提示词').props.onClick(); await ui.flush()
  ui.button('复制结果').props.onClick(); ui.button('关闭').props.onClick(); await ui.flush()
  copy.resolve(); await ui.flush()
  assert.deepEqual(writes, ['润色后的结果'])
  assert.equal(ui.button('复制结果'), undefined)
  assert.doesNotMatch(ui.text(), /润色后的结果|已复制结果/)
})

test('复制启动后发生未渲染的修订变化，回执不得恢复过期结果', async () => {
  const copy = deferred(), writes = []
  const ui = harness({ clipboard: { writeText: text => { writes.push(text); return copy.promise } } })
  await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
  ui.button('润色提示词').props.onClick(); await ui.flush()
  ui.button('复制结果').props.onClick()
  ui.input.draftRev = 2
  copy.resolve(); await ui.flush()
  assert.deepEqual(writes, ['润色后的结果'], '已开始的用户复制不能撤销')
  assert.equal(ui.nodes().some(node => node.type === 'textarea'), false)
  assert.match(ui.text(), /已变化/)
})

test('剪贴板不可用或拒绝时保留可选文本，并提示手动复制', async () => {
  for (const clipboard of [undefined, { writeText: async () => { throw new Error('secret clipboard error') } }]) {
    const ui = harness({ clipboard })
    await ui.flush(); ui.mount('composer-assist-polish-preview'); ui.mount('composer-assist-polish'); await ui.flush()
    ui.button('润色提示词').props.onClick(); await ui.flush()
    ui.button('复制结果').props.onClick(); await ui.flush()
    assert.match(ui.text(), /手动复制/)
    assert.doesNotMatch(ui.text(), /secret clipboard error/)
    assert.ok(ui.nodes().some(node => node.type === 'textarea' && node.props.readOnly && node.props.value === '润色后的结果'))
    assert.deepEqual(ui.setDraftCalls, [])
    assert.ok(ui.button('复制结果'))
  }
})
