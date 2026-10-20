import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { createComputerInputQueue, ComputerTextInput } from '../client/computer-input.js'
import { patchCoreClientSource } from '../scripts/patch-core-input.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('computer input queue preserves IME/paste text and keyboard ordering, combines pending text', async () => {
  let finish
  const calls = []
  const queue = createComputerInputQueue(async job => {
    calls.push({ ...job })
    if (calls.length === 1) await new Promise(resolve => { finish = resolve })
    return { ok: true }
  })
  queue.push({ sn: 'one', kind: 'text', text: '测试' })
  queue.push({ sn: 'one', kind: 'text', text: ' hello' })
  queue.push({ sn: 'one', kind: 'text', text: ' 👋\n' })
  queue.push({ sn: 'one', kind: 'key', key: 'Backspace' })
  assert.equal(calls.length, 1)
  finish()
  await tick()
  assert.deepEqual(calls.map(j => j.text || j.key), ['测试', ' hello 👋\n', 'Backspace'])
})

test('an uncertain result halts and exposes outstanding text without replay', async () => {
  let finish, failure
  const calls = []
  const queue = createComputerInputQueue(async job => {
    calls.push(job)
    await new Promise(resolve => { finish = resolve })
    throw new Error('unknown result')
  }, { error: (error, jobs) => { failure = { error, jobs } } })
  queue.push({ sn: 'one', kind: 'text', text: 'first' })
  queue.push({ sn: 'one', kind: 'text', text: 'next' })
  finish()
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(failure.jobs.map(j => j.text).join(''), 'firstnext')
  assert.equal(queue.push({ kind: 'text', text: 'no retry' }), false)
})

test('oversize text is rejected before any request; cancelling drops queued work', async () => {
  let finish
  const calls = [], errors = []
  const queue = createComputerInputQueue(async job => {
    calls.push(job)
    await new Promise(resolve => { finish = resolve })
    return { ok: true }
  }, { invalid: error => errors.push(error) })
  assert.equal(queue.push({ kind: 'text', text: '中'.repeat(1366) }), false)
  assert.equal(queue.push({ kind: 'text', text: '\ud800' }), false)
  assert.equal(errors.length, 2)
  queue.push({ kind: 'text', text: 'already in flight' })
  queue.push({ kind: 'text', text: 'pending' })
  assert.equal(queue.cancel().length, 1)
  finish()
  await tick()
  assert.equal(calls.length, 1)
})

// Minimal hook renderer drives event handlers without depending on a DOM package.
function renderPanel(props) {
  const hooks = []
  let index = 0
  const React = {
    useState(initial) {
      const position = index++
      if (!(position in hooks)) hooks[position] = initial
      return [hooks[position], value => { hooks[position] = typeof value === 'function' ? value(hooks[position]) : value }]
    },
    useRef(initial) {
      const position = index++
      if (!(position in hooks)) hooks[position] = { current: initial }
      return hooks[position]
    },
    useEffect() {},
  }
  const h = (type, attrs, ...children) => ({ type, attrs: attrs || {}, children })
  return () => {
    index = 0
    return ComputerTextInput({ React, h, active: true, sn: 'one', providerId: 'hos', ...props })
  }
}
function find(tree, type) {
  if (!tree || typeof tree !== 'object') return null
  if (tree.type === type) return tree
  return tree.children?.map(child => find(child, type)).find(Boolean)
}

test('IME preedit and candidate Enter stay local; one committed word is sent', async () => {
  const calls = []
  const render = renderPanel({ call: async (...args) => { calls.push(args); return { ok: true } } })
  let tree = render()
  find(tree, 'input').attrs.onChange({ target: { checked: true } })
  tree = render()
  const area = find(tree, 'textarea').attrs
  const element = { value: 'ceshi' }
  area.onCompositionStart()
  area.onChange({ currentTarget: element, nativeEvent: { isComposing: true } })
  area.onKeyDown({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: true } })
  assert.equal(calls.length, 0)
  element.value = '测试一下'
  area.onCompositionEnd({ currentTarget: element })
  // A subsequent browser input sees the already cleared composition buffer.
  area.onChange({ currentTarget: element, nativeEvent: { isComposing: false } })
  await tick()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['hos', 'desktop:input', { sn: 'one', kind: 'text', text: '测试一下' }])
})

test('Ctrl+V forwards exact raw multiline paste content once', async () => {
  const calls = []
  const render = renderPanel({ call: async (...args) => { calls.push(args); return { ok: true } } })
  find(render(), 'input').attrs.onChange({ target: { checked: true } })
  const area = find(render(), 'textarea').attrs
  area.onKeyDown({ key: 'v', ctrlKey: true, nativeEvent: {}, preventDefault() { assert.fail('native paste shortcut was blocked') } })
  let prevented = false
  area.onPaste({ clipboardData: { getData: () => '  中文\r\nEnglish 👋\r\n' }, preventDefault() { prevented = true } })
  await tick()
  assert.equal(prevented, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].text, '  中文\r\nEnglish 👋\r\n')
})

function findButton(tree, label) {
  if (!tree || typeof tree !== 'object') return null
  if (tree.type === 'button' && tree.children.includes(label)) return tree
  return tree.children?.map(child => findButton(child, label)).find(Boolean)
}

test('an existing local draft cannot enable live mode and send a premature Enter', async () => {
  const calls = []
  const render = renderPanel({ call: async (...args) => { calls.push(args); return { ok: true } } })
  find(render(), 'textarea').attrs.onChange({ currentTarget: { value: 'hello' }, nativeEvent: {} })
  let tree = render()
  assert.equal(find(tree, 'input').attrs.disabled, true)
  find(tree, 'input').attrs.onChange({ target: { checked: true } })
  tree = render()
  find(tree, 'textarea').attrs.onKeyDown({ key: 'Enter', nativeEvent: {} })
  await tick()
  assert.equal(calls.length, 0)
  assert.equal(find(render(), 'textarea').attrs.value, 'hello')
})

test('rejected live paste switches to local editing before Enter or Backspace', async () => {
  const calls = []
  const render = renderPanel({ call: async (...args) => { calls.push(args); return { ok: true } } })
  find(render(), 'input').attrs.onChange({ target: { checked: true } })
  let area = find(render(), 'textarea').attrs
  area.onPaste({ clipboardData: { getData: () => 'x'.repeat(4097) }, preventDefault() {} })
  area = find(render(), 'textarea').attrs
  area.onKeyDown({ key: 'Enter', nativeEvent: {} })
  area.onKeyDown({ key: 'Backspace', nativeEvent: {} })
  await tick()
  assert.equal(calls.length, 0)
  assert.equal(area.value.length, 4097)
})

test('pending clipboard read locks editing and cancellation prevents late device input', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let resolveClipboard
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: { readText: () => new Promise(resolve => { resolveClipboard = resolve }) },
  } })
  try {
    const calls = []
    const render = renderPanel({ call: async (...args) => { calls.push(args); return { ok: true } } })
    find(render(), 'input').attrs.onChange({ target: { checked: true } })
    const reading = findButton(render(), '粘贴电脑文本').attrs.onClick()
    let tree = render()
    assert.equal(find(tree, 'textarea').attrs.disabled, true)
    find(tree, 'textarea').attrs.onChange({ currentTarget: { value: 'B' }, nativeEvent: {} })
    tree.attrs.onKeyDown({ key: 'Escape', preventDefault() {} })
    resolveClipboard('A')
    await reading
    await tick()
    assert.equal(calls.length, 0)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
    else delete globalThis.navigator
  }
})

test('IME final input before compositionend is committed by the deferred fallback', async () => {
  const calls = []
  const render = renderPanel({ call: async (...args) => { calls.push(args); return { ok: true } } })
  find(render(), 'input').attrs.onChange({ target: { checked: true } })
  const area = find(render(), 'textarea').attrs
  const element = { value: '中文' }
  area.onCompositionStart()
  area.onChange({ currentTarget: element, nativeEvent: { isComposing: true } })
  area.onCompositionEnd({ currentTarget: element })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].text, '中文')
})

test('core input patch rejects unknown clients', () => {
  assert.throws(() => patchCoreClientSource('unknown client'), /Unsupported core client/)
})

test('core input patch is idempotent and produces valid JavaScript', { skip: !process.env.DSH_CORE_TEST_ROOT }, () => {
  let source = readFileSync(process.env.DSH_CORE_TEST_ROOT + '/client/client.js', 'utf8')
  const patched = patchCoreClientSource(source)
  assert.equal(patchCoreClientSource(patched), patched)
  new Script(patched)
  assert.match(patched, /caps\.computerTextInput/)
})
