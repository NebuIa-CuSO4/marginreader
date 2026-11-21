import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ClipboardCopy, RefreshCw, X } from 'lucide-react'
import type { ChatMessage, ConversationInspection } from '../../shared/types'

type Tab = 'transcript' | 'context'

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

export function InspectorPage({ projectId }: { projectId: string }): React.JSX.Element {
  const [data, setData] = useState<ConversationInspection | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('transcript')
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  async function load(): Promise<void> {
    setError('')
    try {
      const next = await window.margin.chat.inspect(projectId)
      setData(next)
      document.documentElement.dataset.theme = next.theme
      document.title = `页边 · ${next.project.title} · 本地会话`
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
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [data, tab])

  const latestTime = useMemo(() => {
    const last = data?.messages[data.messages.length - 1]
    return last?.createdAt ?? data?.conversation?.updatedAt ?? 0
  }, [data])

  async function copyConversationId(): Promise<void> {
    if (!data?.conversation) return
    await window.margin.app.copyText(data.conversation.id)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="inspector-shell">
      <header className="inspector-header">
        <div>
          <span className="inspector-kicker">本地真实会话 · 只读</span>
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
                  <span>消息总数</span>
                  <strong>{data.stats.total}</strong>
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
              <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>
                完整会话（{data.messages.length}）
              </button>
              <button className={tab === 'context' ? 'active' : ''} onClick={() => setTab('context')}>
                下一次请求上下文（{data.context.length}）
              </button>
            </div>

            {tab === 'transcript' ? (
              <div className="inspector-note">
                按本地数据库原始顺序显示，底部为最新。这里包含全部消息（包括失败、停止），用于核对保存结果；实际发给 API 的上下文见上方标签。
              </div>
            ) : (
              <div className="inspector-note">
                API 是无状态的。这里显示的是当前会话下一次发消息时会附带的历史上下文；不包含你尚未输入的新问题。失败、停止的消息不会进入上下文。
              </div>
            )}

            <div className="inspector-transcript" ref={scrollRef}>
              {tab === 'transcript' ? (
                data.messages.length === 0 ? (
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
                      <pre>{message.content || '（空消息）'}</pre>
                    </article>
                  ))
                )
              ) : (
                data.context.map((message, index) => (
                  <article key={`${message.role}-${index}`} className={`inspector-message ${message.role}`}>
                    <div className="inspector-message-head">
                      <strong>
                        {message.role === 'system'
                          ? '系统提示'
                          : message.role === 'user'
                            ? '历史用户'
                            : '历史助手'}
                      </strong>
                      <span>#{index + 1}</span>
                    </div>
                    <pre>{message.content}</pre>
                  </article>
                ))
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
