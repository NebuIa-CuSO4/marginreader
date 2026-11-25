import { useState } from 'react'
import type { HistoryFilter, HistoryPreview } from '../../../shared/api'

const dayMs = 86_400_000

interface Props {
  projectId: string
  projectTitle: string
  archiveImages: boolean
  onArchiveImages: (value: boolean) => Promise<void>
  onMessagesChanged: (projectId: string) => Promise<void>
}

function summary(result: HistoryPreview): string {
  const size = (result.fileBytes / (1024 * 1024)).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  return `${result.messages} 条消息、${result.logs} 份请求日志、${result.images} 张图片，约 ${size} MiB 文件`
}

export function HistorySettings(props: Props): React.JSX.Element {
  const [days, setDays] = useState(30)
  const [messages, setMessages] = useState(false)
  const [logs, setLogs] = useState(false)
  const [images, setImages] = useState(true)
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<{ filter: HistoryFilter; result: HistoryPreview } | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState(false)

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(false)
    setNotice('')
    try {
      await work()
    } catch (cause) {
      setError(true)
      setNotice(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作失败，请重试。')
    } finally {
      setBusy(false)
    }
  }

  function preview(): void {
    const filter = { projectId: props.projectId, before: Date.now() - days * dayMs, messages, logs, images }
    void run(async () => {
      setPlan(null)
      const result = await window.margin.history.preview(filter)
      setPlan({ filter, result })
      setNotice('将清理 ' + summary(result))
    })
  }

  function remove(): void {
    if (!plan || plan.filter.projectId !== props.projectId) return
    if (!window.confirm('确定清理以下本地数据？\n' + summary(plan.result) + '\n此操作无法撤销。')) return
    const { filter } = plan
    setPlan(null)
    void run(async () => {
      try {
        const result = await window.margin.history.remove(filter)
        setNotice('已清理 ' + summary(result))
      } finally {
        if (filter.messages) await props.onMessagesChanged(filter.projectId)
      }
    })
  }

  const canRemove = plan && plan.filter.projectId === props.projectId &&
    (plan.result.messages || plan.result.logs || plan.result.images)

  return (
    <section>
      <h4>截图存档与历史清理</h4>
      <label className="check-row">
        <input type="checkbox" checked={props.archiveImages} disabled={busy}
          onChange={(event) => {
            const checked = event.target.checked
            void run(() => props.onArchiveImages(checked))
          }} />
        <span>保留后续请求中的截图原图</span>
      </label>
      <div className="setting-row">
        <strong>清理超过以下天数的数据</strong>
        <select aria-label="清理时间范围" value={days} disabled={busy} onChange={(event) => {
          setDays(Number(event.target.value))
          setPlan(null)
          setNotice('')
        }}>
          {[1, 7, 30, 90].map((value) => <option key={value} value={value}>{value} 天</option>)}
        </select>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={messages} disabled={busy || !props.projectId}
          onChange={(event) => { setMessages(event.target.checked); setPlan(null); setNotice('') }} />
        <span>当前项目「{props.projectTitle || '未选择项目'}」的旧消息</span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={logs} disabled={busy}
          onChange={(event) => { setLogs(event.target.checked); setPlan(null); setNotice('') }} />
        <span>所有项目的旧请求日志及关联截图</span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={logs || images} disabled={busy || logs}
          onChange={(event) => { setImages(event.target.checked); setPlan(null); setNotice('') }} />
        <span>所有项目的旧截图存档</span>
      </label>
      <p className="rail-empty">清理消息会保留项目、笔记、生词与待办。请求日志可能含聊天内容和 OCR 文字。</p>
      <div className="settings-actions">
        <button type="button" className="ghost-button" disabled={busy || !(messages || logs || images)} onClick={preview}>预览清理</button>
        <button type="button" className="ghost-button danger" disabled={busy || !canRemove} onClick={remove}>确认清理</button>
      </div>
      {notice && <p className={error ? 'form-error' : 'rail-empty'} role={error ? 'alert' : 'status'}>{notice}</p>}
    </section>
  )
}
