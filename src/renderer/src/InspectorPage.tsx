import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ClipboardCopy, RefreshCw, X } from 'lucide-react'
import type {
  ChatMessage,
  ChatRequestLog,
  ConversationInspection,
  RequestPart
} from '../../shared/types'
import { MarkdownPlain } from './components/Markdown'

type Tab = 'requests' | 'transcript'

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function statusLabel(status: ChatMessage['status']): string {
  if (status === 'complete') return '完成'
  if (status === 'error') return '失败'
  if (status === 'interrupted') return '已停止'
  if (status === 'streaming') return '生成中'
  if (status === 'sending') return '发送中'
  return status
}

function statusClass(status: ChatMessage['status']): string {
  if (status === 'complete') return 'complete'
  if (status === 'error') return 'error'
  if (status === 'interrupted') return 'interrupted'
  return 'pending'
}

function outcomeLabel(outcome: ChatRequestLog['outcome']): string {
  if (outcome === 'done') return '成功'
  if (outcome === 'error') return '失败'
  if (outcome === 'stopped') return '已停止'
  return '进行中'
}

function RequestPartView({ part, onImage }: { part: RequestPart; onImage: (url: string) => void }): React.JSX.Element {
  if (part.type === 'text') return <MarkdownPlain content={part.text} />
  return (
    <div className="inspector-image">
      <span className="inspector-image-label">图片内容 · {part.description}</span>
      {part.imageUrl && (
        <button className="ghost-button" onClick={() => onImage(part.imageUrl)}>
          查看原图
        </button>
      )}
    </div>
  )
}

export function InspectorPage({ projectId }: { projectId: string }): React.JSX.Element {
  const [data, setData] = useState<ConversationInspection | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('requests')
  const [copied, setCopied] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)

  async function load(): Promise<void> {
    setError('')
    try {
      const next = await window.margin.chat.inspect(projectId)
      setData(next)
      document.documentElement.dataset.theme = next.theme
      document.title = `页边 · ${next.project.title} · 实际发送记录`
      setSelectedId((current) => {
        if (current && next.logs.some((log) => log.requestId === current)) return current
        return next.logs[0]?.requestId ?? null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [projectId])

  useEffect(() => {
    let timer: number | null = null
    const schedule = (): void => {
      if (timer) return
      timer = window.setTimeout(() => {
        timer = null
        void load()
      }, 600)
    }
    const off = window.margin.chat.onStream((event) => {
      if (event.projectId !== projectId) return
      if (event.phase === 'done' || event.phase === 'error' || event.phase === 'stopped') {
        schedule()
      }
    })
    return () => {
      if (timer) window.clearTimeout(timer)
      off()
    }
  }, [projectId])

  useEffect(() => {
    const panel = detailRef.current
    if (!panel) return
    const frame = requestAnimationFrame(() => {
      panel.scrollTop = panel.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedId])

  useEffect(() => {
    if (tab !== 'transcript') return
    const panel = transcriptRef.current
    if (!panel) return
    const frame = requestAnimationFrame(() => {
      panel.scrollTop = panel.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [tab, data])

  const selected = useMemo(() => data?.logs.find((log) => log.requestId === selectedId) ?? null, [data, selectedId])

  const latestTime = useMemo(() => {
    const last = data?.messages[data.messages.length - 1]
    return last?.createdAt ?? 0
  }, [data])

  async function copyConversationId(): Promise<void> {
    if (!data?.conversation) return
    await window.margin.app.copyText(data.conversation.id)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function openLogImage(log: ChatRequestLog, fileName: string): Promise<void> {
    const url = await window.margin.chat.readRequestLogImage(log.requestId, fileName)
    if (url) setPreview(url)
  }

  return (
    <div className="inspector-shell">
      <header className="inspector-header">
        <div>
          <span className="inspector-kicker">实际发送给 API 的请求 · 只读</span>
          <h1>{data?.project.title ?? '本地会话'}</h1>
          <p>
            {data?.provider?.name ?? '未配置 API'}
            {data?.conversation?.model ? ` · ${data.conversation.model}` : ''}
          </p>
        </div>
        <div className="inspector-header-actions">
          <button className="ghost-button" onClick={() => void load()}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            刷新
          </button>
          <button className="ghost-button" onClick={() => void window.margin.window.closeCurrent()}>
            <X size={14} />
            关闭
          </button>
        </div>
      </header>

      <div className="inspector-body">
        {loading && !data ? (
          <div className="inspector-empty">正在读取本地会话…</div>
        ) : error ? (
          <div className="inspector-empty error">{error}</div>
        ) : data ? (
          <>
            <section className="inspector-meta">
              <div className="inspector-meta-row">
                <span>会话 ID</span>
                <code>{data.conversation?.id ?? '未创建'}</code>
                {data.conversation && (
                  <button className="mini-icon" title="复制会话 ID" onClick={() => void copyConversationId()}>
                    {copied ? <Check size={14} /> : <ClipboardCopy size={14} />}
                  </button>
                )}
              </div>
              <div className="inspector-meta-grid">
                <div>
                  <span>数据来源</span>
                  <strong>{data.conversation?.source === 'migrated-web' ? '旧网页迁移' : 'API'}</strong>
                </div>
                <div>
                  <span>最后消息</span>
                  <strong>{latestTime ? formatTime(latestTime) : '—'}</strong>
                </div>
                <div>
                  <span>API 密钥</span>
                  <strong>{data.provider?.hasKey ? '已配置' : '未配置'}</strong>
                </div>
                <div>
                  <span>请求记录</span>
                  <strong>
                    {data.logs.length} / {data.logLimit}
                  </strong>
                </div>
              </div>
              <div className="inspector-stats">
                <span className="inspector-stat complete">完成 {data.stats.complete}</span>
                <span className="inspector-stat error">失败 {data.stats.error}</span>
                <span className="inspector-stat interrupted">停止 {data.stats.interrupted}</span>
                <span className="inspector-stat">用户 {data.stats.user}</span>
                <span className="inspector-stat">助手 {data.stats.assistant}</span>
              </div>
              {data.mismatched > 0 && (
                <div className="inspector-warning">
                  发现 {data.mismatched} 条消息的 conversation_id 与当前会话不一致。
                </div>
              )}
            </section>

            <div className="inspector-tabs">
              <button className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>
                实际请求（{data.logs.length}）
              </button>
              <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>
                完整会话（{data.messages.length}）
              </button>
            </div>

            {tab === 'requests' ? (
              <div className="inspector-split">
                <div className="inspector-log-list">
                  {data.logs.length === 0 ? (
                    <div className="inspector-empty">
                      这个项目还没有 0.2.3 之后的请求记录。发送一条新消息后会出现。
                    </div>
                  ) : (
                    data.logs.map((log) => (
                      <button
                        key={log.requestId}
                        className={`inspector-log-item ${log.requestId === selectedId ? 'active' : ''}`}
                        onClick={() => setSelectedId(log.requestId)}
                      >
                        <div className="inspector-log-top">
                          <span className={`inspector-badge ${log.outcome ?? 'pending'}`}>
                            {outcomeLabel(log.outcome)}
                          </span>
                          <span>{formatTime(log.createdAt)}</span>
                        </div>
                        <p>{log.displayText.slice(0, 90) || '（无文字）'}</p>
                        <span className="inspector-log-meta">
                          {log.model} · {log.request.length} 条消息{log.webSearch ? ' · 联网搜索' : ''}
                          {log.imageAttached ? ' · 含图片' : ''}
                          {log.ocrApplied ? ' · OCR' : ''}
                          {log.screenContextApplied ? ' · 屏幕上下文' : ''}
                        </span>
                      </button>
                    ))
                  )}
                </div>
                <div className="inspector-log-detail" ref={detailRef}>
                  {!selected ? (
                    <div className="inspector-empty">选择左侧的一条请求查看完整内容。</div>
                  ) : (
                    <>
                      <div className="inspector-detail-head">
                        <strong>{formatTime(selected.createdAt)}</strong>
                        <span className={`inspector-badge ${selected.outcome ?? 'pending'}`}>
                          {outcomeLabel(selected.outcome)}
                        </span>
                        <span className="inspector-model">{selected.provider}</span>
                        <span className="inspector-model">{selected.model}</span>
                      </div>
                      <div className="inspector-note">
                        这是实际发给 API 的完整请求体（系统提示、历史消息、当前文字、截图与自动补充的文字）。
                      </div>
                      {selected.request.map((message, index) => (
                        <article
                          key={`${selected.requestId}-${index}`}
                          className={`inspector-message ${message.role}`}
                        >
                          <div className="inspector-message-head">
                            <strong>
                              {message.role === 'system'
                                ? '系统提示'
                                : message.role === 'user'
                                  ? '用户'
                                  : '助手'}
                            </strong>
                            <span>#{index + 1}</span>
                          </div>
                          {message.text !== undefined ? (
                            <MarkdownPlain content={message.text} />
                          ) : (
                            (message.parts ?? []).map((part, partIndex) => (
                              <RequestPartView
                                key={`${index}-${partIndex}`}
                                part={part}
                                onImage={setPreview}
                              />
                            ))
                          )}
                        </article>
                      ))}
                      <div className="inspector-legend">
                        <span>
                          录制说明：显示文字 {selected.displayText.length} 字 · 实际发送 {selected.apiText.length} 字
                        </span>
                        <span>
                          历史 {selected.trim.historyCount} 条 → 发送 {selected.trim.sentMessageCount} 条 · 上限{' '}
                          {selected.trim.messageLimit} 条 / {selected.trim.charLimit} 字
                        </span>
                        {selected.imageAttached && <span>图片已作为多模态内容发送</span>}
                        {selected.ocrApplied && <span>模型不支持图片，已改用 OCR 文字</span>}
                        {selected.imageOmitted && <span className="error">图片没有发送</span>}
                      </div>
                      {selected.images.length > 0 && (
                        <div className="inspector-image-links">
                          {selected.images.map((fileName) => (
                            <button
                              key={fileName}
                              className="ghost-button"
                              onClick={() => void openLogImage(selected, fileName)}
                            >
                              查看存档图片 {fileName}
                            </button>
                          ))}
                        </div>
                      )}
                      {selected.error && (
                        <div className="inspector-warning">错误：{selected.error}</div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="inspector-note">
                  本地数据库中的完整会话记录（含失败 / 停止）。请求实际发送内容请查看“实际请求”。
                </div>
                <div className="inspector-transcript" ref={transcriptRef}>
                  {data.messages.length === 0 ? (
                    <div className="inspector-empty">这个项目还没有消息。</div>
                  ) : (
                    data.messages.map((message) => (
                      <article
                        key={message.id}
                        className={`inspector-message ${message.role} ${statusClass(message.status)}`}
                      >
                        <div className="inspector-message-head">
                          <strong>{message.role === 'user' ? '用户' : '助手'}</strong>
                          <span>{formatTime(message.createdAt)}</span>
                          <span className={`inspector-badge ${statusClass(message.status)}`}>
                            {statusLabel(message.status)}
                          </span>
                          {message.model && <span className="inspector-model">{message.model}</span>}
                          {message.usage && (
                            <span className="inspector-model">
                              {message.usage.promptTokens}+{message.usage.completionTokens} tokens
                            </span>
                          )}
                        </div>
                        {message.content ? (
                          <MarkdownPlain content={message.content} />
                        ) : (
                          <pre className="inspector-text">（空消息）</pre>
                        )}
                      </article>
                    ))
                  )}
                </div>
              </>
            )}
          </>
        ) : null}
      </div>

      {preview && (
        <div className="inspector-preview" onClick={() => setPreview(null)}>
          <img src={preview} alt="截图预览" />
        </div>
      )}
    </div>
  )
}
