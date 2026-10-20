// Optional integration against an installed core, without touching its files or
// capturing a device screenshot. Set DSH_CORE_TEST_ROOT to the package directory.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { patchCoreSource } from '../scripts/patch-core-version.mjs'
import { readInstalledDshVersion } from '../lib/dsh-version.js'

const root = process.env.DSH_CORE_TEST_ROOT
function extract(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, name)
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end + 2)
}
test('installed core screenshot entry keeps old-version, permission and approval gates', { skip: !root }, async () => {
  const source = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const patched = patchCoreSource(source)
  for (const name of ['visionGateCheck', 'toolScreenshot']) assert.equal(extract(patched, name), extract(source, name))
  const setup = [
    'let dshVersionPromise = null',
    ...['parseVersion', 'cmpPreId', 'compareVersion', 'readDshVersion'].map(name => extract(patched, name)),
    'async ' + extract(patched, 'visionGateCheck'), extract(patched, 'toolScreenshot'),
    'toolScreenshot(ctx)',
  ].join('\n')
  async function execute({ version = readInstalledDshVersion(), denied = false, refused = false } = {}) {
    let snapshots = 0, approvals = 0
    const context = {
      readInstalledDshVersion: () => version,
      ctx: { get: () => ({}) }, H: key => key, OUT_ERR: {}, MIN_DSH_VERSION: '0.1.0-rc8',
      defineTool: tool => tool,
      requireFocused: () => ({ ok: true, sn: 'test-device', provider: 'hos' }),
      permGate: () => denied ? { ok: false, error: 'permission off' } : { ok: true, mode: 'confirm' },
      resolveVisionModel: async () => ({ ok: true, provider: 'test', model: 'vision' }),
      requireAction: () => ({ ok: true, call: async () => { snapshots++; return { ok: true, bytes: [], mediaType: 'image/jpeg' } } }),
      gateApproval: async () => { approvals++; return refused ? { ok: false, error: 'user refused' } : { ok: true } },
      runVision: async () => ({ ok: true, text: 'mock recognition' }),
    }
    const result = await vm.runInNewContext(setup, context).execute({ prompt: 'test' }, {})
    return { result, snapshots, approvals }
  }
  const current = await execute()
  assert.equal(current.result.ok, true)
  assert.equal(current.snapshots, 1)
  assert.equal(current.approvals, 1)
  const old = await execute({ version: '0.1.0-rc7' })
  assert.equal(old.result.error, 'err.oldDsh')
  assert.equal(old.snapshots, 0)
  const unknown = await execute({ version: '' })
  assert.equal(unknown.result.error, 'err.badDshVersion')
  const denied = await execute({ denied: true })
  assert.equal(denied.result.error, 'permission off')
  assert.equal(denied.snapshots, 0)
  const refused = await execute({ refused: true })
  assert.equal(refused.result.error, 'user refused')
  assert.equal(refused.snapshots, 0)
})
