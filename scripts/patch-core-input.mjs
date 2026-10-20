// Explicit opt-in companion patch: the provider does not silently modify core.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const baseline = '5472036894ea8a818982ab53f135b268e6d248da327d2ec34cebcbed3dcba01b'
const anchor = "    const React = require('react')\n"
const renderAnchor = "            }),\n          ),\n          settingsOpen ? h(SettingsDialog"
const kbdOriginal = "const kbdText = kbdCap === false ? T('panel.kbdUnsupported')"
const kbdReplacement = "const kbdText = kbdCap === false ? (caps.computerTextInput ? '电脑输入可用 · 使用下方输入区' : T('panel.kbdUnsupported'))"
const render = `            caps.computerTextInput ? h(ComputerTextInput, {
              key: sn + ':' + port, React: React, h: h, sn: sn,
              providerId: props.providerId, call: providerCall,
              active: placement !== 'hidden' && status === 'playing',
            }) : null,
`
const mark = '// DSH_COMPUTER_INPUT_PATCH_V1'
const helper = readFileSync(new URL('../client/computer-input.js', import.meta.url), 'utf8').replace(/^export /gm, '')
const injection = mark + '\n' + helper + '\n// END_DSH_COMPUTER_INPUT_PATCH_V1\n'

export function patchCoreClientSource(source) {
  source = source.replace(/\r\n/g, '\n')
  let original = source
  if (source.includes(mark)) {
    if (source.split(injection).length !== 2 || source.split(render).length !== 2) throw new Error('Existing input patch differs; review it before updating')
    original = source.replace(injection, '').replace(render, '').replace(kbdReplacement, kbdOriginal)
  }
  if (createHash('sha256').update(original).digest('hex') !== baseline) throw new Error('Unsupported core client: expected the verified 1.0.2 source')
  if (source.includes(mark)) return source
  if (source.split(anchor).length !== 2 || source.split(renderAnchor).length !== 2) throw new Error('Core client anchors are not unique')
  return source.replace(anchor, anchor + injection)
    .replace(renderAnchor, "            }),\n" + render + "          ),\n          settingsOpen ? h(SettingsDialog")
    .replace(kbdOriginal, kbdReplacement)
}

export function patchCoreInput(root, check = false) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== '@nszzj/dsh-scrcpy-core' || manifest.version !== '1.0.2') throw new Error('Expected @nszzj/dsh-scrcpy-core 1.0.2')
  const path = join(root, 'client', 'client.js')
  const source = readFileSync(path, 'utf8')
  const patched = patchCoreClientSource(source)
  if (source.replace(/\r\n/g, '\n') === patched) return 'already patched'
  if (check) return 'compatible (no files changed)'
  if (existsSync(path + '.before-computer-input')) throw new Error('Backup exists; inspect the previous patch before retrying')
  writeFileSync(path + '.before-computer-input', source, { flag: 'wx' })
  writeFileSync(path, patched)
  return 'patched; completely restart DSH and refresh the mirroring panel'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const roots = args.filter(a => a !== '--check')
  if (roots.length !== 1 || args.some(a => a.startsWith('--') && a !== '--check')) {
    console.error('Usage: node scripts/patch-core-input.mjs <core-package-directory> [--check]')
    process.exitCode = 1
  } else {
    try { console.log(patchCoreInput(resolve(roots[0]), args.includes('--check'))) }
    catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}
