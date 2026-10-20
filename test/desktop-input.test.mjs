import test from 'node:test'
import assert from 'node:assert/strict'
import { createDesktopInputHandler } from '../lib/desktop-input.js'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const marker = command => command.match(/__DSH_DESKTOP_KEY_[a-f0-9]{24}__/)[0]
function setup(overrides = {}) {
  const calls = []
  const handler = createDesktopInputHandler({
    isConnected: sn => ['a', 'b'].includes(sn),
    deviceOnline: async sn => ({ ok: true, hdc: 'hdc:' + sn }),
    injectText: async (hdc, sn, text) => { calls.push({ hdc, sn, text }); return { ok: true, text } },
    run: async (hdc, args) => {
      calls.push({ hdc, args })
      return { ok: true, stdout: '\n' + marker(args[3]) + ':0\n' }
    },
    ...overrides,
  })
  return { handler, calls }
}

test('text keeps exact Unicode, quotes and surrounding whitespace without key events', async () => {
  const { handler, calls } = setup()
  const text = '  测试一下😀 \'" $(); \\c\r\n\n'
  const result = await handler({ sn: 'a', kind: 'text', text })
  assert.equal(result.ok, true)
  assert.equal(result.text, text)
  assert.deepEqual(calls, [{ hdc: 'hdc:a', sn: 'a', text }])
  for (const text of ['', 'a\0b', '\ud800', '测'.repeat(1366), undefined, 42]) {
    assert.equal((await handler({ sn: 'a', kind: 'text', text })).ok, false)
  }
  assert.equal(calls.length, 1)
  assert.equal((await handler({ sn: 'a', kind: 'text', text: 'a'.repeat(4096) })).ok, true)
})

test('only mapped key events are sent, including explicit Enter and safe modifiers', async () => {
  const { handler, calls } = setup()
  const codes = { Backspace: 2055, Delete: 2071, Enter: 2054, Tab: 2049, ArrowUp: 2012,
    ArrowDown: 2013, ArrowLeft: 2014, ArrowRight: 2015, Home: 2081, End: 2082 }
  for (const [key, code] of Object.entries(codes)) {
    assert.equal((await handler({ sn: 'a', kind: 'key', key })).ok, true)
    assert.ok(calls.at(-1).args[3].startsWith(`uinput -K -d ${code} -u ${code};`))
  }
  assert.equal((await handler({ sn: 'a', kind: 'key', key: 'SelectAll' })).ok, true)
  assert.ok(calls.at(-1).args[3].startsWith('uinput -K -d 2072 -d 2017 -u 2017 -u 2072;'))
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Home', 'End']) {
    assert.equal((await handler({ sn: 'a', kind: 'key', key, shift: true })).ok, true)
    assert.ok(calls.at(-1).args[3].startsWith(`uinput -K -d 2047 -d ${codes[key]} -u ${codes[key]} -u 2047;`))
  }
  for (const { hdc, args } of calls) {
    assert.equal(hdc, 'hdc:a')
    assert.deepEqual(args.slice(0, 3), ['-t', 'a', 'shell'])
    assert.match(args[3], /^[\x00-\x7f]+$/)
  }
})

test('rejects disconnected devices, unknown types/keys and unsupported modifiers before I/O', async () => {
  const { handler, calls } = setup()
  for (const args of [null, {}, { sn: 'c', kind: 'text', text: 'x' },
    { sn: 'a', kind: 'shell', text: 'id' }, { sn: 'a', kind: 'key', key: 'Enter;id' },
    { sn: 'a', kind: 'key', key: 'constructor' }, { sn: 'a', kind: 'key', key: 2054 },
    { sn: 'a', kind: 'key', key: 'SelectAll', shift: true }, { sn: 'a', kind: 'key', key: 'ArrowUp', shift: 'true' }]) {
    assert.equal((await handler(args)).ok, false)
  }
  assert.equal(calls.length, 0)
})

test('requests run FIFO per device while other devices remain independent', async () => {
  const started = deferred(), release = deferred(), calls = []
  const { handler } = setup({ injectText: async (_, sn, text) => {
    calls.push(sn + ':' + text)
    if (text === 'one') { started.resolve(); await release.promise }
    return { ok: true }
  } })
  const first = handler({ sn: 'a', kind: 'text', text: 'one' })
  await started.promise
  const second = handler({ sn: 'a', kind: 'text', text: 'two' })
  const third = handler({ sn: 'a', kind: 'text', text: 'three' })
  assert.equal((await handler({ sn: 'b', kind: 'text', text: 'parallel' })).ok, true)
  assert.deepEqual(calls, ['a:one', 'b:parallel'])
  release.resolve()
  assert.ok((await Promise.all([first, second, third])).every(r => r.ok))
  assert.deepEqual(calls, ['a:one', 'b:parallel', 'a:two', 'a:three'])
})

test('failure cancels already queued work without retry; a later explicit request succeeds', async () => {
  const started = deferred(), release = deferred(), calls = []
  const { handler } = setup({ injectText: async (_, sn, text) => {
    calls.push(text)
    if (text === 'fail') { started.resolve(); await release.promise; return { ok: false, error: 'partial input' } }
    return { ok: true }
  } })
  const first = handler({ sn: 'a', kind: 'text', text: 'fail' })
  await started.promise
  const second = handler({ sn: 'a', kind: 'text', text: 'queued' })
  const third = handler({ sn: 'a', kind: 'key', key: 'Enter' })
  release.resolve()
  assert.equal((await first).ok, false)
  const fresh = handler({ sn: 'a', kind: 'text', text: 'fresh' })
  assert.equal((await second).cancelled, true)
  assert.equal((await third).cancelled, true)
  assert.equal((await fresh).ok, true)
  assert.deepEqual(calls, ['fail', 'fresh'])
})

test('queued work checks connection again and cancels subsequent queued requests', async () => {
  const started = deferred(), release = deferred()
  let connected = true, inputs = 0
  const { handler } = setup({ isConnected: () => connected, injectText: async () => {
    inputs++; started.resolve(); await release.promise; return { ok: true }
  } })
  const first = handler({ sn: 'a', kind: 'text', text: 'first' })
  await started.promise
  const second = handler({ sn: 'a', kind: 'text', text: 'second' })
  const third = handler({ sn: 'a', kind: 'text', text: 'third' })
  connected = false
  release.resolve()
  assert.equal((await first).ok, true)
  assert.equal((await second).ok, false)
  assert.equal((await third).cancelled, true)
  assert.equal(inputs, 1)
})

test('disconnect during deviceOnline lookup prevents any input', async () => {
  let connected = true
  const { handler, calls } = setup({ isConnected: () => connected, deviceOnline: async () => {
    connected = false; return { ok: true, hdc: 'hdc' }
  } })
  assert.equal((await handler({ sn: 'a', kind: 'text', text: 'x' })).ok, false)
  assert.equal(calls.length, 0)
})

test('remote status must be unique and final; transport exit zero is not enough; never retries', async () => {
  for (const mode of ['nonzero', 'missing', 'wrong', 'duplicate', 'trailing', 'transport', 'throw']) {
    let calls = 0
    const { handler } = setup({ run: async (_, args) => {
      calls++
      if (mode === 'throw') throw new Error('spawn failed')
      const current = marker(args[3])
      let stdout = '\n' + current + ':' + (mode === 'nonzero' ? '37' : '0') + '\n'
      if (mode === 'missing') stdout = ''
      if (mode === 'wrong') stdout = '\n__DSH_DESKTOP_KEY_wrong__:0\n'
      if (mode === 'duplicate') stdout += stdout
      if (mode === 'trailing') stdout += 'extra'
      return { ok: mode !== 'transport', stdout, stderr: 'transport failed' }
    } })
    assert.equal((await handler({ sn: 'a', kind: 'key', key: 'Backspace' })).ok, false, mode)
    assert.equal(calls, 1, mode)
  }
})

test('key failure also cancels queued text and Enter without executing either', async () => {
  const started = deferred(), release = deferred()
  let keyCalls = 0
  const { handler, calls } = setup({ run: async (_, args) => {
    keyCalls++; started.resolve(); await release.promise
    return { ok: true, stdout: '\n' + marker(args[3]) + ':9\n' }
  } })
  const first = handler({ sn: 'a', kind: 'key', key: 'Backspace' })
  await started.promise
  const second = handler({ sn: 'a', kind: 'text', text: 'never inserted' })
  const third = handler({ sn: 'a', kind: 'key', key: 'Enter' })
  release.resolve()
  assert.equal((await first).ok, false)
  assert.equal((await second).cancelled, true)
  assert.equal((await third).cancelled, true)
  assert.equal(keyCalls, 1)
  assert.equal(calls.length, 0)
})
