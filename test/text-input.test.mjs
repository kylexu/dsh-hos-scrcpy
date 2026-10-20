import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { buildTextInputCommand, injectUtf8Text } from '../lib/text-input.js'

const samples = ['测试一下', '中文😀 café', "  a'b\"c\\d $HOME $(printf wrong); & | < > `id` %s _\t\n\n", ' _\n', 'plain ASCII']
const marker = command => command.match(/__DSH_INPUT_STATUS_[a-f0-9]{24}__/)[0]

test('UTF-8 text is encoded into an ASCII-only command with no user shell syntax', () => {
  for (const text of samples) {
    const request = buildTextInputCommand(text)
    assert.match(request.command, /^[\x00-\x7f]+$/)
    const encoded = request.command.match(/printf '%b_' '((?:\\0[0-7]{3})+)'/)[1]
    const decoded = Buffer.from([...encoded.matchAll(/\\0([0-7]{3})/g)].map(m => parseInt(m[1], 8)))
    assert.equal(decoded.toString('utf8'), text)
    assert.ok(request.command.includes('"$dsh_text"'))
    assert.ok(!request.command.includes('uinput'))
    assert.ok(request.command.endsWith('"$dsh_input_status"'))
  }
})
test('rejects NUL, malformed Unicode and oversized text before any device operation', async () => {
  let calls = 0
  for (const text of ['', 'a\0b', '\ud800', '测'.repeat(1366)]) {
    const result = await injectUtf8Text(async () => { calls++ }, 'hdc', 'sn', text)
    assert.equal(result.ok, false)
  }
  assert.equal(calls, 0)
  assert.doesNotThrow(() => buildTextInputCommand('a'.repeat(4096)))
})
test('success requires both transport and the unique final remote status marker', async () => {
  const text = ' 测试一下\n\n'
  const result = await injectUtf8Text(async (exe, args) => {
    assert.equal(exe, 'hdc')
    assert.deepEqual(args.slice(0, 3), ['-t', 'device-id', 'shell'])
    return { ok: true, stdout: 'input output\n' + marker(args[3]) + ':0\r\n' }
  }, 'hdc', 'device-id', text)
  assert.deepEqual(result, { ok: true, text })
})
test('remote failure, missing status and transport errors never retry input', async () => {
  for (const mode of ['remote failure', 'missing', 'wrong marker', 'transport', 'trailing data', 'duplicate marker']) {
    let calls = 0
    const result = await injectUtf8Text(async (_, args) => {
      calls++
      const current = marker(args[3])
      return { ok: mode !== 'transport', stderr: '', stdout: mode === 'missing' ? ''
        : mode === 'wrong marker' ? '\n__DSH_INPUT_STATUS_000000000000000000000000__:0\n'
          : (mode === 'duplicate marker' ? '\n' + current + ':0\n' : '') + '\n' + current + ':' + (mode === 'remote failure' ? '37' : '0') + '\n' + (mode === 'trailing data' ? 'unexpected' : '') }
    }, 'hdc', 'sn', '测试一下')
    assert.equal(result.ok, false, mode)
    assert.equal(calls, 1, mode)
    assert.match(result.error, /未自动重试/)
  }
})
test('active provider action preserves Chinese, quotes and trailing whitespace', async () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function actionInput(')
  const end = source.indexOf('\n}', start) + 2
  let received
  const action = vm.runInNewContext(source.slice(start, end) + '\nactionInput', {
    deviceOnline: async sn => ({ ok: true, hdc: 'hdc:' + sn }),
    injectText: async (hdc, sn, text) => { received = { hdc, sn, text }; return { ok: true } },
  })
  const text = " 测试一下 '\n\n"
  assert.equal((await action('sn', { text })).ok, true)
  assert.deepEqual(received, { hdc: 'hdc:sn', sn: 'sn', text })
})
