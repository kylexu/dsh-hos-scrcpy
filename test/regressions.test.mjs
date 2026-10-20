import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { parseDisplaySize, layoutResult } from '../lib/layout.js'
import { readAsarManifest, readInstalledDshVersion } from '../lib/dsh-version.js'
import { patchCore, patchCoreSource } from '../scripts/patch-core-version.mjs'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const functionSource = name => {
  const start = source.indexOf('function ' + name + '(')
  const end = source.indexOf('\n}\n', start) + 2
  assert.ok(start >= 0 && end > start)
  return source.slice(start, end)
}
const { parseUiControls, compressControls } = vm.runInNewContext(functionSource('parseUiControls') + '\n' + functionSource('clamp01') .split('\n')[0] + '\n' + functionSource('compressControls') + '\n({parseUiControls, compressControls})')
const displayDump = (width, height) => `
---------------- Screen ID: 0 ----------------
isInternal: true
---------------- Screen ID: 1165 ----------------
isInternal: false
---------------- Display ID: 1165 ----------------
[DISPLAY INFO]
Width: 800
Height: 1280
---------------- Display ID: 0 ----------------
[DISPLAY INFO]
Width: ${width}
Height: ${height}
`
const node = (text, bounds, extra = {}) => ({ attributes: { text, bounds, visible: 'true', enabled: 'true', clickable: 'true', ...extra } })
const controls = nodes => parseUiControls(JSON.stringify({ children: nodes }))

test('logical internal display dimensions follow portrait and landscape, not mirror scale', () => {
  assert.deepEqual(parseDisplaySize(displayDump(1600, 2560)), { width: 1600, height: 2560 })
  assert.deepEqual(parseDisplaySize(displayDump(2560, 1600)), { width: 2560, height: 1600 })
  assert.equal(parseDisplaySize('render resolution=1600x2560'), null)
  assert.equal(parseDisplaySize(displayDump(0, 2560)), null)
})
test('status-bar-only regression does not return 1600x137 coordinates', () => {
  const result = layoutResult(controls([node('11:25', '[0,0][1600,137]')]), { width: 1600, height: 2560 }, compressControls)
  assert.equal(result.ok, true)
  assert.equal(result.realW, 1600)
  assert.equal(result.realH, 2560)
  assert.equal(result.items[0].fy, 69 / 2560)
})
test('partial application layouts normalize against display dimensions', () => {
  const result = layoutResult(controls([node('发送', '[800,1000][1000,1100]')]), { width: 1600, height: 2560 }, compressControls)
  assert.equal(result.ok, true)
  assert.equal(result.items[0].fx, 900 / 1600)
  assert.equal(result.items[0].fy, 1050 / 2560)
  assert.equal(result.realH, 2560)
})
test('legitimate top toolbar and partially visible rows remain usable', () => {
  const result = layoutResult(controls([node('返回', '[0,150][200,250]'), node('边缘项', '[-20,500][200,600]')]), { width: 1600, height: 2560 }, compressControls)
  assert.equal(result.ok, true)
  assert.equal(result.items.length, 2)
})
test('missing dimensions, empty layouts and off-screen nodes fail explicitly', () => {
  assert.equal(layoutResult([], null, compressControls).ok, false)
  assert.equal(layoutResult([], { width: 1600, height: 2560 }, compressControls).ok, false)
  assert.equal(layoutResult(controls([node('outside', '[1600,2000][2000,3000]')]), { width: 1600, height: 2560 }, compressControls).ok, false)
})
test('provider action requests dimensions on selected device and propagates errors', async () => {
  const calls = []
  const context = {
    deviceOnline: async () => ({ ok: true, hdc: 'hdc' }),
    dumpUiLayout: async () => ({ ok: true, json: JSON.stringify({ children: [node('发送', '[800,1000][1000,1100]')] }) }),
    run: async (...args) => { calls.push(args); return { ok: true, stdout: displayDump(1600, 2560) } },
    parseDisplaySize, layoutResult, parseUiControls, compressControls,
  }
  const action = vm.runInNewContext('async ' + functionSource('actionDumpLayout') + '\nactionDumpLayout', context)
  assert.equal((await action('test-device')).realH, 2560)
  assert.deepEqual(Array.from(calls[0][1]), ['-t', 'test-device', 'shell', 'hidumper', '-s', 'DisplayManagerService', '-a', '-a'])
  context.run = async () => ({ ok: false, stderr: 'permission denied' })
  assert.match((await action('test-device')).error, /permission denied/)
})

function temporary(t) {
  const path = mkdtempSync(join(os.tmpdir(), 'hos-scrcpy-test-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function manifest(path, version, name = '@deepseek-ai/dsh') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ name, version }))
}
function archive(path, version) {
  const payload = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  const header = Buffer.from(JSON.stringify({ files: { dsh: { files: { node_modules: { files: { '@deepseek-ai': { files: { dsh: { files: { 'package.json': { size: payload.length, offset: '0' } } } } } } } } } } }))
  const headerSize = 8 + header.length + ((4 - header.length % 4) % 4)
  const prefix = Buffer.alloc(8 + headerSize)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(headerSize, 4)
  prefix.writeUInt32LE(headerSize - 4, 8)
  prefix.writeUInt32LE(header.length, 12)
  header.copy(prefix, 16)
  writeFileSync(path, Buffer.concat([prefix, payload]))
}
test('reads desktop embedded runtime manifest from a real ASAR structure', t => {
  const dir = temporary(t), path = join(dir, 'app.asar')
  archive(path, '0.2.1-rc.2')
  assert.equal(readAsarManifest(path, 'dsh/node_modules/@deepseek-ai/dsh/package.json').version, '0.2.1-rc.2')
  assert.equal(readInstalledDshVersion({ env: { DSH_HOME: dir, DSH_ASAR_PATH: path }, execPath: join(dir, 'node') }), '0.2.1-rc.2')
})
test('supports custom profile and old CLI layouts; rejects invalid and unrelated versions', t => {
  const dir = temporary(t), profile = join(dir, 'custom-profile')
  const path = join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const options = { env: { DSH_HOME: dir, DSH_PROFILE_DIR: profile }, execPath: join(dir, 'node') }
  manifest(path, 'garbage')
  assert.equal(readInstalledDshVersion(options), '')
  manifest(path, '0.2.1', 'unrelated')
  assert.equal(readInstalledDshVersion(options), '')
  manifest(path, '0.1.0-rc7')
  assert.equal(readInstalledDshVersion(options), '0.1.0-rc7') // must not mask an old version
  writeFileSync(path, '{')
  const cli = join(dir, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  manifest(cli, '0.2.0')
  assert.equal(readInstalledDshVersion(options), '0.2.0')
})
test('unrelated desktop install cannot override an old active profile', t => {
  const dir = temporary(t), profile = join(dir, 'profile')
  const desktop = join(dir, 'Programs', 'DeepSeek Harness', 'resources')
  mkdirSync(desktop, { recursive: true })
  archive(join(desktop, 'app.asar'), '0.2.1-rc.2')
  manifest(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '0.1.0-rc7')
  const options = { env: { DSH_HOME: join(dir, 'home'), DSH_PROFILE_DIR: profile, LOCALAPPDATA: dir }, execPath: join(dir, 'worker', 'node') }
  assert.equal(readInstalledDshVersion(options), '0.1.0-rc7')
  options.env.DSH_ASAR_PATH = join(desktop, 'app.asar')
  assert.equal(readInstalledDshVersion(options), '0.2.1-rc.2')
})
test('malformed/truncated ASAR fails without a whole-archive allocation', t => {
  const dir = temporary(t), path = join(dir, 'app.asar')
  writeFileSync(path, Buffer.from('broken'))
  assert.throws(() => readAsarManifest(path, 'package.json'), /Truncated/)
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(0xffffffff, 4)
  writeFileSync(path, prefix)
  assert.throws(() => readAsarManifest(path, 'package.json'), /Invalid/)
})

// A fixture of the supported detector; the live core entry and gates are checked below.
const coreFixture = `let dshVersionPromise = null
function readDshVersion() {
  if (dshVersionPromise) return dshVersionPromise
  dshVersionPromise = (async function () {
    const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
    const candidates = [
      join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    ]
    for (const p of candidates) {
      try {
        const o = JSON.parse(readFileSync(p, 'utf8'))
        if (o && o.version) return String(o.version)
      } catch (e) {}
    }
    return ''
  })()
  return dshVersionPromise
}
`
test('core patch is opt-in, backed up, idempotent and fails closed for unknown source', t => {
  const dir = temporary(t)
  manifest(join(dir, 'package.json'), '1.0.2', '@nszzj/dsh-scrcpy-core')
  mkdirSync(join(dir, 'lib'))
  const path = join(dir, 'lib', 'index.js')
  writeFileSync(path, coreFixture)
  assert.match(patchCore(dir, true), /no files changed/)
  assert.equal(readFileSync(path, 'utf8'), coreFixture)
  assert.equal(existsSync(path + '.before-dsh-version-fix'), false)
  assert.match(patchCore(dir), /restart/)
  assert.equal(readFileSync(path + '.before-dsh-version-fix', 'utf8'), coreFixture)
  assert.equal(patchCore(dir), 'already patched')
  assert.throws(() => patchCoreSource('different implementation'), /Unsupported/)
  manifest(join(dir, 'package.json'), '2.0.0', '@nszzj/dsh-scrcpy-core')
  assert.throws(() => patchCore(dir), /1.0.x/)
})
test('version detection retries failure and caches success', async () => {
  let calls = 0
  const patched = patchCoreSource(coreFixture).replace(/^import[^\n]+\n/, '')
  const fn = vm.runInNewContext(patched + '\nreadDshVersion', { readInstalledDshVersion: () => ++calls === 1 ? '' : '0.2.1-rc.2' })
  assert.equal(await fn(), '')
  assert.equal(await fn(), '0.2.1-rc.2')
  assert.equal(await fn(), '0.2.1-rc.2')
  assert.equal(calls, 2)
})
