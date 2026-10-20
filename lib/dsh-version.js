import { readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import os from 'node:os'

const validVersion = v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)
const runtimeVersion = value => value && value.name === '@deepseek-ai/dsh' && validVersion(value.version) ? value.version : ''

// Node workers do not have Electron's transparent ASAR filesystem support.
// Read only the bounded header and the requested manifest, never the whole app.
export function readAsarManifest(archive, member) {
  const fd = openSync(archive, 'r')
  const read = (length, position) => {
    const buffer = Buffer.alloc(length)
    if (readSync(fd, buffer, 0, length, position) !== length) throw new Error('Truncated ASAR')
    return buffer
  }
  try {
    const prefix = read(16, 0)
    const headerSize = prefix.readUInt32LE(4)
    const jsonSize = prefix.readUInt32LE(12)
    if (headerSize < 8 || headerSize > 16 * 1024 * 1024 || jsonSize > headerSize - 8) throw new Error('Invalid ASAR header')
    let entry = JSON.parse(read(jsonSize, 16).toString('utf8'))
    for (const part of member.split('/')) entry = entry.files?.[part]
    const offset = Number(entry?.offset), size = entry?.size
    if (entry?.unpacked || entry?.link || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 1 || size > 1024 * 1024) throw new Error('Invalid ASAR manifest')
    return JSON.parse(read(size, 8 + headerSize + offset).toString('utf8'))
  } finally { closeSync(fd) }
}

export function readInstalledDshVersion(options = {}) {
  const env = options.env || process.env
  const home = env.DSH_HOME || join(os.homedir(), '.dsh')
  const candidates = [
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    ...['web', 'desktop'].map(profile => join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
  ]
  if (env.DSH_PROFILE_DIR) candidates.unshift(join(env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  try { candidates.unshift(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')) } catch {}
  const archives = []
  if (env.DSH_ASAR_PATH) archives.push(env.DSH_ASAR_PATH)
  const resources = options.resourcesPath ?? process.resourcesPath
  if (resources) archives.push(join(resources, 'app.asar'))
  // Covers Electron and worker executables inside the desktop distribution.
  let parent = dirname(options.execPath || process.execPath)
  for (let depth = 0; depth < 8; depth++) {
    archives.push(join(parent, 'app.asar'), join(parent, 'resources', 'app.asar'))
    const next = dirname(parent)
    if (next === parent) break
    parent = next
  }
  const fallbackArchives = []
  if (env.LOCALAPPDATA) fallbackArchives.push(join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
  for (const base of ['/Applications', join(os.homedir(), 'Applications')]) fallbackArchives.push(join(base, 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'))
  const fromArchives = paths => {
    for (const archive of new Set(paths.map(p => resolve(p)))) {
      try {
        const version = runtimeVersion(readAsarManifest(archive, 'dsh/node_modules/@deepseek-ai/dsh/package.json'))
        if (version) return version
      } catch {}
    }
    return ''
  }
  // Only archives identified by the current process or explicit configuration
  // precede CLI profiles. A separately installed desktop is merely a fallback.
  const activeVersion = fromArchives(archives)
  if (activeVersion) return activeVersion
  for (const path of new Set(candidates)) {
    try {
      const version = runtimeVersion(JSON.parse(readFileSync(path, 'utf8')))
      if (version) return version
    } catch {}
  }
  return env.DSH_PROFILE === 'desktop' ? fromArchives(fallbackArchives) : ''
}
