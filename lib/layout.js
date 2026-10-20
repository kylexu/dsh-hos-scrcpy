// DisplayManagerService reports logical dimensions after rotation. Do not use
// RenderService's physical mode or the bounds of whichever UI nodes are visible.
export function parseDisplaySize(output) {
  const screens = new Map()
  const screenPattern = /-{3,}\s*Screen ID:\s*(\d+)\s*-{3,}([\s\S]*?)(?=-{3,}\s*(?:Screen|Display) ID:|$)/g
  for (const match of String(output).matchAll(screenPattern)) {
    screens.set(match[1], /isInternal:\s*true\b/.test(match[2]))
  }
  const displays = []
  const displayPattern = /-{3,}\s*Display ID:\s*(\d+)\s*-{3,}\s*\[DISPLAY INFO\]\s*Width:\s*(\d+)\s*Height:\s*(\d+)/g
  for (const match of String(output).matchAll(displayPattern)) {
    const width = Number(match[2]), height = Number(match[3])
    if (width > 0 && height > 0) displays.push({ id: match[1], width, height })
  }
  // Prefer the internal display, never the scaled scrcpy virtual display.
  const display = displays.find(d => screens.get(d.id)) || displays.find(d => d.id === '0')
  return display ? { width: display.width, height: display.height } : null
}

export function layoutResult(controls, size, compress) {
  if (!size || !(size.width > 0 && size.height > 0)) {
    return { ok: false, error: '无法获取设备真实显示尺寸，不能安全计算控件比例坐标。请检查 DisplayManagerService。' }
  }
  const { width, height } = size
  const visible = controls.filter(c => c.cx >= 0 && c.cy >= 0 && c.cx <= width && c.cy <= height)
  // Sparse trees can be either system bars or legitimate blank application
  // pages. Preserve their controls, always normalized to the real display.
  const items = compress(visible, width, height)
  if (!items.length) return { ok: false, error: '未解析到任何可用控件（布局为空或全部不可见）' }
  return { ok: true, items, realW: width, realH: height }
}
