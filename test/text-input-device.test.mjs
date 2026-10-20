// Optional, read-only roundtrip on a real device. The shell function overrides
// uitest: it prints text bytes and never invokes the device's input command.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { injectUtf8Text } from '../lib/text-input.js'

const hdc = process.env.DSH_HDC_TEST_PATH
const sn = process.env.DSH_HDC_TEST_SN
const run = (exe, args) => new Promise(resolve => execFile(exe, args, { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => resolve({ ok: !error, exitCode: error?.code, stdout, stderr })))

test('real HDC shell preserves text bytes without injecting device input', { skip: !hdc || !sn }, async () => {
  const samples = ['测试一下', '中文😀 café', "  a'b\"c\\d\\c\\n $HOME $(printf wrong); & | < > `id` %s _\t\r\n\n", ' _\n', '   ']
  for (const text of samples) {
    let bytes
    const result = await injectUtf8Text(async (exe, args) => {
      const request = [...args]
      request[3] = 'uitest() { printf \'%s\' "$3" | od -An -tx1; return 0; }; ' + args[3]
      const response = await run(exe, request)
      const hex = response.stdout.split('__DSH_INPUT_STATUS_')[0].trim().replace(/\s/g, '')
      bytes = Buffer.from(hex, 'hex')
      return response
    }, hdc, sn, text)
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(bytes, Buffer.from(text, 'utf8'))
  }
  let calls = 0
  const failed = await injectUtf8Text(async (exe, args) => {
    calls++
    const request = [...args]
    request[3] = 'uitest() { return 37; }; ' + args[3]
    return run(exe, request)
  }, hdc, sn, '测试一下')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /37/)
  assert.equal(calls, 1)
})
