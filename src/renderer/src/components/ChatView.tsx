import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  Camera,
  Copy,
  Languages,
  Loader2,
  MousePointer2,
  Send,
  Square,
  StickyNote,
  X
} from 'lucide-react'
import type { ChatMessage } from '../../../shared/types'
import { stripVocabBlock } from '../../../shared/vocab'
import { Markdown } from './Markdown'
import { ReasoningBlock } from './ReasoningBlock'

interface ChatViewProps {
  messages: ChatMessage[]
  messagesHasMore: boolean
  loadingOlder: boolean
  onLoadOlder: () => Promise<void>
  sending: boolean
  composer: string
  hasBinding: boolean
  pendingImage: { dataUrl: string; width: number; height: number } | null
  onRemoveImage: () => void
  onComposerChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onCapture: () => void
  onSelectionHelp: () => void
  onSaveAnswer: (content: string) => void
  onRecoverAnswer: (assistantId: string) => void
  onOpenWeb: () => void
  onSaveVocabAnswer: (answer: string, question: string) => void
}

interface MessageRowProps {
  message: ChatMessage
  previousUser: ChatMessage | undefined
  onSaveAnswer: (content: string) => void
  onRecoverAnswer: (assistantId: string) => void
  onOpenWeb: () => void
  onSaveVocabAnswer: (answer: string, question: string) => void
}

const MessageRow = memo(function MessageRow({
  message,
  previousUser,
  onSaveAnswer,
  onRecoverAnswer,
  onOpenWeb,
  onSaveVocabAnswer
}: MessageRowProps): React.JSX.Element {
  const displayContent = stripVocabBlock(message.content)
  return (
    <article className={`message ${message.role} ${message.status}`}>
      {message.role === 'user' ? (
        <div className="user-bubble">{message.content}</div>
      ) : (
        <div className="assistant-card">
          <div className="assistant-topline">
            <span className="assistant-mark">M</span>
            <span>页边</span>
            {message.status === 'streaming' && <Loader2 size={13} className="spin" />}
          </div>
          <ReasoningBlock
            text={message.reasoning ?? ''}
            streaming={message.status === 'streaming'}
          />
          {message.status === 'error' ? (
            <div className="message-error">
              <span>{message.content || '回答失败'}</span>
              <div className="error-actions">
                <button className="error-action" onClick={() => onRecoverAnswer(message.id)}>
                  尝试读取网页最后一条回答
                </button>
                <button className="error-action" onClick={onOpenWeb}>
                  打开网页面板确认
                </button>
              </div>
            </div>
          ) : displayContent ? (
            <Markdown content={displayContent} />
          ) : message.content ? (
            <div className="vocab-only">已提取词汇信息，可以点“存生词”。</div>
          ) : (
            <div className="thinking">
              <span />
              <span />
              <span />
            </div>
          )}
          {message.status === 'interrupted' && (
            <div className="message-note">这次回答被中断了。</div>
          )}
          {message.content && message.status !== 'error' && (
            <div className="message-actions">
              {displayContent && (
                <>
                  <button
                    className="icon-text-button"
                    onClick={() => void window.margin.app.copyText(displayContent)}
                  >
                    <Copy size={13} />
                    复制
                  </button>
                  <button
                    className="icon-text-button"
                    onClick={() => onSaveAnswer(displayContent)}
                  >
                    <StickyNote size={13} />
                    存笔记
                  </button>
                </>
              )}
              <button
                className="icon-text-button vocab-save"
                onClick={() => onSaveVocabAnswer(message.content, previousUser?.content ?? '')}
              >
                <Languages size={13} />
                存生词
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  )
})

export function ChatView({
  messages,
  messagesHasMore,
  loadingOlder,
  onLoadOlder,
  sending,
  composer,
  hasBinding,
  pendingImage,
  onRemoveImage,
  onComposerChange,
  onSend,
  onStop,
  onCapture,
  onSelectionHelp,
  onSaveAnswer,
  onRecoverAnswer,
  onOpenWeb,
  onSaveVocabAnswer
}: ChatViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const nearBottomRef = useRef(true)
  const initializedRef = useRef(false)
  const pendingOlderRef = useRef<{
    height: number
    top: number
    count: number
  } | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const initialScrollFrameRef = useRef<number | null>(null)

  const actionRef = useRef({ onSaveAnswer, onRecoverAnswer, onOpenWeb, onSaveVocabAnswer })
  actionRef.current = { onSaveAnswer, onRecoverAnswer, onOpenWeb, onSaveVocabAnswer }

  const actions = useMemo(
    () => ({
      saveAnswer: (content: string) => actionRef.current.onSaveAnswer(content),
      recoverAnswer: (assistantId: string) => actionRef.current.onRecoverAnswer(assistantId),
      openWeb: () => actionRef.current.onOpenWeb(),
      saveVocabAnswer: (answer: string, question: string) =>
        actionRef.current.onSaveVocabAnswer(answer, question)
    }),
    []
  )

  const previousUsers = useMemo(() => {
    const map = new Map<string, ChatMessage | undefined>()
    let previous: ChatMessage | undefined
    for (const message of messages) {
      map.set(message.id, previous)
      if (message.role === 'user') previous = message
    }
    return map
  }, [messages])

  function markScrollPosition(): void {
    const el = scrollRef.current
    if (!el) return
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96
  }

  function scrollToBottom(): void {
    const el = scrollRef.current
    if (!el) return
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      el.scrollTop = el.scrollHeight
    })
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const pending = pendingOlderRef.current
    if (pending && messages.length > pending.count) {
      el.scrollTop = pending.top + (el.scrollHeight - pending.height)
      pendingOlderRef.current = null
      return
    }
    if (!initializedRef.current) {
      initializedRef.current = true
      nearBottomRef.current = true
      el.scrollTop = el.scrollHeight
      // Code blocks, fonts and KaTeX can change height immediately after the
      // first paint. Re-run once the next frame has final layout.
      initialScrollFrameRef.current = requestAnimationFrame(() => {
        initialScrollFrameRef.current = null
        el.scrollTop = el.scrollHeight
        nearBottomRef.current = true
      })
      return
    }
    if (nearBottomRef.current) scrollToBottom()
  }, [messages])

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
      if (initialScrollFrameRef.current !== null) {
        cancelAnimationFrame(initialScrollFrameRef.current)
      }
    }
  }, [])

  async function handleLoadOlder(): Promise<void> {
    if (loadingOlder || !messagesHasMore) return
    const el = scrollRef.current
    if (!el) return
    pendingOlderRef.current = {
      height: el.scrollHeight,
      top: el.scrollTop,
      count: messages.length
    }
    nearBottomRef.current = false
    try {
      await onLoadOlder()
    } finally {
      // The layout effect clears this as soon as the older page is committed.
      // This timeout only covers a failed/empty request.
      window.setTimeout(() => {
        if (pendingOlderRef.current?.count === messages.length) {
          pendingOlderRef.current = null
        }
      }, 1500)
    }
  }

  function handleSend(): void {
    nearBottomRef.current = true
    onSend()
  }

  return (
    <section className="chat-view">
      <div className="chat-scroll" ref={scrollRef} onScroll={markScrollPosition}>
        {messages.length === 0 ? (
          <div className="empty-chat">
            <div className="empty-orb">
              <span>M</span>
            </div>
            <h2>把读不懂的地方交给页边</h2>
            <p>截图会作为图片附加到提问里，也可以选中任意应用里的文字直接追问。</p>
            <div className="empty-actions">
              <button className="soft-button" onClick={onCapture}>
                <Camera size={16} />
                截图提问
              </button>
              <button className="soft-button" onClick={onSelectionHelp}>
                <MousePointer2 size={16} />
                划词解释
              </button>
            </div>
          </div>
        ) : (
          <div className="message-list">
            {messagesHasMore && (
              <div className="load-more">
                <button
                  className="soft-button"
                  onClick={() => void handleLoadOlder()}
                  disabled={loadingOlder}
                >
                  {loadingOlder ? '正在加载…' : '加载更早的消息'}
                </button>
              </div>
            )}
            {messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                previousUser={previousUsers.get(message.id)}
                onSaveAnswer={actions.saveAnswer}
                onRecoverAnswer={actions.recoverAnswer}
                onOpenWeb={actions.openWeb}
                onSaveVocabAnswer={actions.saveVocabAnswer}
              />
            ))}
          </div>
        )}
      </div>

      <div className="composer-wrap">
        {!hasBinding && (
          <div className="composer-hint">
            第一次发送会为当前项目创建一条 DeepSeek 网页对话，之后固定复用。
          </div>
        )}
        <div className="composer">
          {pendingImage && (
            <div className="composer-attachment">
              <img src={pendingImage.dataUrl} alt="待发送的截图" />
              <div className="composer-attachment-meta">
                <span>截图</span>
                <span>
                  {pendingImage.width} × {pendingImage.height}
                </span>
              </div>
              <button
                className="composer-attachment-remove"
                title="移除截图"
                onClick={onRemoveImage}
                type="button"
              >
                <X size={14} />
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={composer}
            onChange={(event) => onComposerChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                handleSend()
              }
            }}
            placeholder="输入问题；截图会作为图片直接上传…"
            rows={3}
          />
          <div className="composer-tools">
            <div className="composer-left">
              <button className="tool-button" title="截图并附加图片" onClick={onCapture}>
                <Camera size={17} />
              </button>
              <button className="tool-button" title="划词翻译 / 解释" onClick={onSelectionHelp}>
                <MousePointer2 size={17} />
              </button>
            </div>
            <div className="composer-right">
              <span className="send-hint">Enter 发送</span>
              {sending ? (
                <button className="send-button stop" title="停止生成" onClick={onStop}>
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-button"
                  title="发送"
                  onClick={handleSend}
                  disabled={!composer.trim() && !pendingImage}
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
