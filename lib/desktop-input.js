import { randomBytes } from 'node:crypto'
import { buildTextInputCommand } from './text-input.js'

const KEYS = Object.freeze({
  Backspace: 2055, Delete: 2071, Enter: 2054, Tab: 2049,
  ArrowUp: 2012, ArrowDown: 2013, ArrowLeft: 2014, ArrowRight: 2015,
  Home: 2081, End: 2082,
})
const SHIFT_LEFT = 2047, CTRL_LEFT = 2072, A = 2017

async function sendKey(run, hdc, sn, key, shift) {
  const codes = key === 'SelectAll' ? [CTRL_LEFT, A]
    : shift ? [SHIFT_LEFT, KEYS[key]] : [KEYS[key]]
  const events = [...codes.map(code => '-d ' + code), ...[...codes].reverse().map(code => '-u ' + code)].join(' ')
  const marker = '__DSH_DESKTOP_KEY_' + randomBytes(12).toString('hex') + '__'
  const command = 'uinput -K ' + events + '; dsh_key_status=$?; ' +
    "printf '\\n" + marker + ":%s\\n' \"$dsh_key_status\""
  const result = await run(hdc, ['-t', sn, 'shell', command])
  const output = String(result?.stdout || '')
  const status = output.split(marker).length === 2
    ? output.match(new RegExp('\\n' + marker + ':(0|[1-9][0-9]*)\\r?\\n$')) : null
  if (!result?.ok || !status || status[1] !== '0') {
    throw new Error(!result?.ok ? (result?.stderr || 'HDC 按键传输失败')
      : !status ? '未收到唯一的设备端完成标记，按键结果未知'
        : '设备端按键失败，退出码 ' + status[1])
  }
  return { ok: true, key, shift }
}

// isConnected(sn) is a synchronous boolean query of currently mirrored devices.
// Only explicit kind:'key', key:'Enter' requests generate an Enter key event.
export function createDesktopInputHandler({ isConnected, deviceOnline, run, injectText }) {
  const queues = new Map()
  return async function desktopInput(args = {}) {
    const { sn, kind, text, key, shift = false } = args || {}
    try {
      if (typeof sn !== 'string' || !sn || sn.trim() !== sn) throw new Error('缺少有效设备序列号')
      if (!isConnected(sn)) throw new Error('设备未连接投屏')
      if (kind === 'text') {
        if (typeof text !== 'string') throw new Error('text 必须是字符串')
        buildTextInputCommand(text) // Reuse exact UTF-8/NUL/4096-byte validation.
      } else if (kind === 'key') {
        if (typeof key !== 'string' || !(key === 'SelectAll' || Object.hasOwn(KEYS, key))) throw new Error('不支持的按键')
        if (typeof shift !== 'boolean' || (shift && key === 'SelectAll')) throw new Error('无效的 Shift 组合键')
      } else throw new Error('不支持的输入类型')
    } catch (error) { return { ok: false, error: String(error.message || error) } }

    let queue = queues.get(sn)
    if (!queue) { queue = { tail: Promise.resolve(), epoch: 0, pending: 0 }; queues.set(sn, queue) }
    const epoch = queue.epoch
    queue.pending++
    const task = queue.tail.then(async () => {
      if (epoch !== queue.epoch) return { ok: false, cancelled: true, error: '前序输入失败，此请求已取消；需要重新明确提交' }
      try {
        if (!isConnected(sn)) throw new Error('设备已断开投屏')
        const online = await deviceOnline(sn)
        if (!online?.ok || !online.hdc) throw new Error(online?.error || '设备不可用')
        if (!isConnected(sn)) throw new Error('设备已断开投屏')
        const result = kind === 'text' ? await injectText(online.hdc, sn, text)
          : await sendKey(run, online.hdc, sn, key, shift)
        if (!result?.ok) throw new Error(result?.error || '文本输入失败')
        return { ...result, sn, kind }
      } catch (error) {
        queue.epoch++ // Invalidate requests already queued, never future submissions.
        return { ok: false, error: String(error.message || error) }
      }
    })
    const done = task.finally(() => {
      if (--queue.pending === 0 && queues.get(sn) === queue) queues.delete(sn)
    })
    queue.tail = done.then(() => undefined, () => undefined)
    return done
  }
}
