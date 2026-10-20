// Explicit companion repair for core 1.0.x. Never runs during provider install.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const marker = "import { readInstalledDshVersion } from './dsh-version.js'"
const original = `function readDshVersion() {
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
}`
const replacement = `function readDshVersion() {
  // Cache successful detection only; a missing installation can be retried.
  if (!dshVersionPromise) {
    const version = readInstalledDshVersion()
    if (version) dshVersionPromise = Promise.resolve(version)
    else return Promise.resolve('')
  }
  return dshVersionPromise
}`

export function patchCoreSource(source) {
  const normalized = source.replace(/\r\n/g, '\n')
  if (normalized.includes(marker)) return normalized
  if (normalized.split(original).length !== 2) throw new Error('Unsupported core source: expected exactly one unmodified 1.0.x version detector')
  return marker + '\n' + normalized.replace(original, replacement)
}

export function patchCore(root, check = false) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== '@nszzj/dsh-scrcpy-core' || !/^1\.0\.\d+$/.test(manifest.version)) throw new Error('Expected @nszzj/dsh-scrcpy-core 1.0.x')
  const path = join(root, 'lib', 'index.js')
  const source = readFileSync(path, 'utf8')
  const patched = patchCoreSource(source)
  const helper = readFileSync(new URL('../lib/dsh-version.js', import.meta.url), 'utf8')
  const helperPath = join(root, 'lib', 'dsh-version.js')
  if (source.replace(/\r\n/g, '\n').includes(marker)) {
    if (!existsSync(helperPath) || readFileSync(helperPath, 'utf8') !== helper) throw new Error('Existing repair has a missing or different helper; inspect it manually')
    return 'already patched'
  }
  if (existsSync(helperPath)) throw new Error('Refusing to overwrite existing dsh-version.js')
  if (existsSync(path + '.before-dsh-version-fix')) throw new Error('Backup already exists; inspect previous repair before retrying')
  if (check) return 'compatible (no files changed)'
  writeFileSync(path + '.before-dsh-version-fix', source, { flag: 'wx' })
  writeFileSync(helperPath, helper, { flag: 'wx' })
  writeFileSync(path, patched)
  return 'patched; completely restart DSH to activate'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const root = args.find(arg => arg !== '--check')
  if (!root || args.some(arg => arg.startsWith('--') && arg !== '--check') || args.filter(arg => arg !== '--check').length !== 1) {
    console.error('Usage: node scripts/patch-core-version.mjs <core-package-directory> [--check]')
    process.exitCode = 1
  } else {
    try { console.log(patchCore(resolve(root), args.includes('--check'))) }
    catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}
