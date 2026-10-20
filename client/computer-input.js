// This module is also embedded into the core 1.0.x client by the explicit patch.
export function createComputerInputQueue(send, events = {}) {
  let pending = [], running = false, stopped = false, closed = false
  const bytes = value => new TextEncoder().encode(value).length
  async function drain() {
    if (running || stopped || closed) return
    running = true
    events.busy?.(true)
    while (pending.length && !stopped && !closed) {
      const job = pending.shift()
      try {
        const result = await send(job)
        if (!result || result.ok !== true) throw new Error(result?.error || '设备未确认输入完成')
      } catch (error) {
        stopped = true
        const unsent = [job].concat(pending)
        pending = []
        if (!closed) events.error?.(String(error.message || error), unsent)
      }
    }
    running = false
    if (!closed) events.busy?.(false)
  }
  return {
    push(job) {
      if (stopped || closed) return false
      if (job.kind === 'text') {
        const text = String(job.text || '')
        if (!text || text.includes('\0') || bytes(text) > 4096 || new TextDecoder().decode(new TextEncoder().encode(text)) !== text) {
          events.invalid?.('单次文本须为有效 Unicode，最多 4096 个 UTF-8 字节，不能包含 NUL。')
          return false
        }
        job = { ...job, text }
      }
      if (pending.length >= 64 || pending.reduce((n, j) => n + bytes(j.text || ''), 0) + bytes(job.text || '') > 16384) {
        events.invalid?.('输入队列已满，请稍后继续。')
        return false
      }
      const last = pending[pending.length - 1]
      if (job.kind === 'text' && last?.kind === 'text' && last.sn === job.sn && bytes(last.text + job.text) <= 4096) last.text += job.text
      else pending.push(job)
      void drain()
      return true
    },
    resume() { if (!closed) stopped = false },
    cancel() { const jobs = pending; pending = []; stopped = true; return jobs },
    close() { closed = true; stopped = true; pending = [] },
  }
}

export function ComputerTextInput(props) {
  const { React, h } = props
  const [draft, setDraft] = React.useState('')
  const [live, setLive] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [composingUI, setComposingUI] = React.useState(false)
  const [readingClipboard, setReadingClipboard] = React.useState(false)
  const clipboardEpoch = React.useRef(0)
  const [message, setMessage] = React.useState('先点击手机输入框，再在这里打字或粘贴。')
  const root = React.useRef(null)
  const area = React.useRef(null)
  const composing = React.useRef(false)
  const liveNow = React.useRef(false)
  const current = React.useRef(props)
  current.current = props
  liveNow.current = live
  const queue = React.useRef(null)
  if (!queue.current) {
    queue.current = createComputerInputQueue(job => {
      if (!current.current.active) throw new Error('投屏已隐藏，输入已停止')
      return current.current.call(current.current.providerId, 'desktop:input', job)
    }, {
      busy: setBusy,
      invalid: error => {
        const jobs = queue.current.cancel()
        setDraft(old => jobs.filter(j => j.kind === 'text').map(j => j.text).join('') + old)
        liveNow.current = false
        setLive(false)
        setMessage(error + ' 已退出实时输入，当前文本保留在本地。')
      },
      error: (error, jobs) => {
        liveNow.current = false
        setLive(false)
        setDraft(old => jobs.filter(j => j.kind === 'text').map(j => j.text).join('') + old)
        setMessage('输入已停止，未自动重试。请核对手机后再操作：' + error)
      },
    })
  }
  React.useEffect(() => {
    if (!props.active) {
      clipboardEpoch.current++
      setReadingClipboard(false)
      const jobs = queue.current.cancel()
      liveNow.current = false
      setLive(false)
      setDraft(old => jobs.filter(j => j.kind === 'text').map(j => j.text).join('') + old)
    }
  }, [props.active])
  React.useEffect(() => () => { clipboardEpoch.current++; queue.current.close() }, [])

  function insert(text) {
    if (!props.active || !text) return false
    return queue.current.push({ sn: props.sn, kind: 'text', text })
  }
  function commit(element) {
    const text = element.value
    if (insert(text)) {
      element.value = ''
      setDraft('')
      setMessage('正在输入到手机。请在画面中核对；聊天发送仍需在手机中操作。')
      return true
    }
    return false
  }
  function sendDraft() {
    if (composing.current || !props.active || !draft) return
    queue.current.resume()
    commit(area.current)
  }
  function keyDown(event) {
    if (readingClipboard) { event.preventDefault(); return }
    if (composing.current || event.nativeEvent?.isComposing || event.keyCode === 229) return
    if (!liveNow.current) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); sendDraft() }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      liveNow.current = false
      setLive(false)
      const jobs = queue.current.cancel()
      setDraft(old => jobs.filter(j => j.kind === 'text').map(j => j.text).join('') + old)
      setMessage('已退出实时输入。')
      return
    }
    if (event.altKey) return
    const shortcut = event.ctrlKey || event.metaKey
    if (shortcut && event.key.toLowerCase() === 'v') return // onPaste submits the raw clipboard text once.
    let key = null
    if (shortcut) {
      if (event.key.toLowerCase() === 'a') key = 'SelectAll'
      else if (['c', 'x'].includes(event.key.toLowerCase())) {
        event.preventDefault()
        setMessage('当前鸿蒙接口不支持读取手机剪贴板。退出实时输入后，可复制此输入区里的文本。')
        return
      } else return
    } else if (['Backspace', 'Delete', 'Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) key = event.key
    if (key) {
      event.preventDefault()
      queue.current.push({ sn: props.sn, kind: 'key', key, shift: event.shiftKey })
    }
  }
  function cancelClipboard() {
    clipboardEpoch.current++
    setReadingClipboard(false)
    setMessage('已取消读取电脑剪贴板。')
  }
  async function pasteFromComputer() {
    if (!props.active || composing.current || busy || readingClipboard) return
    if (liveNow.current && area.current?.value && !commit(area.current)) return
    const epoch = ++clipboardEpoch.current
    setReadingClipboard(true)
    setMessage('正在读取电脑剪贴板文本…')
    try {
      const text = await navigator.clipboard.readText()
      if (epoch !== clipboardEpoch.current || !current.current.active) return
      queue.current.resume()
      if (text) insert(text)
      else setMessage('电脑剪贴板没有可粘贴的文本。')
    } catch {
      if (epoch !== clipboardEpoch.current) return
      setMessage('浏览器未允许读取剪贴板。请在输入区按 Ctrl+V，再点“输入到手机”。')
    } finally {
      if (epoch === clipboardEpoch.current) setReadingClipboard(false)
    }
  }
  function leaveInput(e) {
    if (root.current?.contains(e.relatedTarget)) return
    if (readingClipboard) cancelClipboard()
    const jobs = queue.current.cancel()
    const wasLive = liveNow.current
    liveNow.current = false
    setLive(false)
    setDraft(old => jobs.filter(j => j.kind === 'text').map(j => j.text).join('') + old)
    if (wasLive) setMessage('已离开电脑输入区，实时输入已停止；未发出的文本保留在本地。')
  }
  const button = { font: 'inherit', cursor: 'pointer', padding: '4px 8px' }
  return h('div', { ref: root, onBlur: leaveInput, onKeyDown: e => { if (readingClipboard && e.key === 'Escape') { e.preventDefault(); cancelClipboard() } }, style: { flex: '0 0 100%', boxSizing: 'border-box', padding: '6px 0', fontSize: '12px', borderTop: '1px solid #8884' } },
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
      h('label', null,
        h('input', { type: 'checkbox', checked: live, disabled: !props.active || busy || readingClipboard || composingUI || (!live && !!draft), title: '请先输入或清空已有草稿，再启用实时输入', onChange: e => {
          if (e.target.checked && (area.current?.value || draft)) { setMessage('请先输入或清空已有草稿，再开启实时输入。'); return }
          queue.current.resume()
          setLive(e.target.checked)
          liveNow.current = e.target.checked
          setMessage(e.target.checked ? '实时输入：在下方打字或 Ctrl+V，文字立即进入手机。Enter 会发送手机回车；Esc 退出。' : '编辑后点“输入到手机”，或按 Ctrl+Enter。')
          area.current?.focus()
        } }), '实时输入'),
      h('button', { style: button, disabled: !props.active || busy || readingClipboard || !draft || live, onClick: sendDraft }, '输入到手机'),
      h('button', { style: button, disabled: !props.active || busy || readingClipboard, onClick: pasteFromComputer }, readingClipboard ? '读取剪贴板中…' : '粘贴电脑文本'),
      readingClipboard ? h('button', { style: button, onClick: cancelClipboard }, '取消读取') : null,
    ),
    h('textarea', {
      ref: area, value: draft, rows: 2, disabled: !props.active || readingClipboard,
      'aria-label': '电脑键盘输入到手机', placeholder: '在此输入中文、英文，或按 Ctrl+V 粘贴电脑文本',
      style: { width: '100%', boxSizing: 'border-box', marginTop: '5px', resize: 'vertical', font: 'inherit', color: 'inherit', background: 'transparent' },
      onKeyDown: keyDown,
      onPaste: e => {
        if (readingClipboard) { e.preventDefault(); return }
        if (!liveNow.current || composing.current) return
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain')
        if (e.currentTarget?.value && !commit(e.currentTarget)) { setDraft(old => old + text); return }
        if (!insert(text) && text) setDraft(old => old + text)
      },
      onCompositionStart: () => { composing.current = true; setComposingUI(true) },
      onCompositionEnd: e => {
        composing.current = false
        setComposingUI(false)
        const element = e.currentTarget
        // Chromium may dispatch its final input before or after compositionend.
        // The input handler clears a committed value, so this deferred fallback
        // only handles browsers that delivered input before compositionend.
        setTimeout(() => { if (liveNow.current && current.current.active && !composing.current) commit(element) }, 0)
      },
      onChange: e => {
        if (readingClipboard) return
        setDraft(e.currentTarget.value)
        if (liveNow.current && !composing.current && !e.nativeEvent?.isComposing) commit(e.currentTarget)
      },
    }),
    h('div', { role: 'status', style: { lineHeight: '1.4', marginTop: '3px', opacity: 0.8 } }, (busy ? '输入中 · ' : '') + message),
    h('div', { style: { opacity: 0.65, fontSize: '11px' } }, '当前支持电脑文本 → 手机输入框；手机剪贴板 → 电脑暂不支持。'),
  )
}
