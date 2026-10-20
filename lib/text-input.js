import { randomBytes } from 'node:crypto'

// Windows hdc may decode argv using the ANSI code page. Keep its entire shell
// command ASCII and reconstruct UTF-8 only after reaching the device.
const MAX_INPUT_BYTES = 4096

export function buildTextInputCommand(text) {
  text = String(text)
  const bytes = Buffer.from(text, 'utf8')
  if (!bytes.length) throw new Error('缺少输入内容')
  if (text.includes('\0')) throw new Error('输入内容不能包含 NUL 字符')
  if (bytes.toString('utf8') !== text) throw new Error('输入内容包含无效的 Unicode 字符')
  // Five ASCII characters per byte; stay safely below Windows argv limits.
  if (bytes.length > MAX_INPUT_BYTES) throw new Error('输入内容过长（最多 4096 个 UTF-8 字节）')
  const octal = [...bytes].map(byte => '\\0' + byte.toString(8).padStart(3, '0')).join('')
  // The appended sentinel preserves trailing newlines in command substitution.
  // Every payload byte is octal, so user text can never become shell syntax.
  const marker = '__DSH_INPUT_STATUS_' + randomBytes(12).toString('hex') + '__'
  const command = "dsh_text=$(printf '%b_' '" + octal + "') || exit $?; " +
    'dsh_text=${dsh_text%_}; ' +
    'uitest uiInput text "$dsh_text"; dsh_input_status=$?; ' +
    "printf '\\n" + marker + ":%s\\n' \"$dsh_input_status\""
  return { command, marker }
}

export async function injectUtf8Text(run, hdc, sn, text) {
  let request
  try { request = buildTextInputCommand(text) }
  catch (error) { return { ok: false, error: error.message } }
  // Never retry after an attempted input: a failed command could have already
  // inserted some or all of the text.
  const result = await run(hdc, ['-t', sn, 'shell', request.command])
  const output = String(result.stdout || '')
  const status = output.split(request.marker).length === 2
    ? output.match(new RegExp('\\n' + request.marker + ':(0|[1-9][0-9]*)\\r?\\n$')) : null
  if (result.ok && status && status[1] === '0') return { ok: true, text: String(text) }
  const detail = !result.ok ? (result.stderr || result.stdout || ('exit ' + result.exitCode))
    : !status ? '未收到设备端完成标记，输入结果未知'
      : '设备端输入命令失败，退出码 ' + status[1] + ': ' + (result.stderr || String(result.stdout || '').split(request.marker)[0].trim())
  return { ok: false, error: '文本注入失败（未自动重试，避免重复输入）: ' + detail }
}
