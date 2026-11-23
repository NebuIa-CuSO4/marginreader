import { useEffect, useState } from 'react'
import { BookOpen, Check, ClipboardList, Pencil, Pin, PinOff, Plus, RefreshCw, Settings, Trash2, Wallet, X } from 'lucide-react'
import { isOfficialDeepSeek } from '../../../shared/types'
import type { ApiProvider, CodexQuota, DeepSeekQuota, Project, QuotaWindow, TodoItem } from '../../../shared/types'

export type RailPanel = 'conversations' | 'todos' | 'quota'

interface WorkspaceRailProps {
  panel: RailPanel | null
  onPanelChange: (panel: RailPanel | null) => void
  pinned: boolean
  onPin: () => void
  onSettings: () => void
  projects: Project[]
  activeProjectId: string
  onActivate: (id: string) => Promise<void>
  onCreate: (title: string, author: string) => Promise<void>
  onDelete: (project: Project) => Promise<void>
  providers: ApiProvider[]
  activeProvider: ApiProvider | null
}

const panelTitles: Record<RailPanel, string> = { conversations: '会话', todos: '待办事项', quota: '余额与额度' }

export function WorkspaceRail(props: WorkspaceRailProps): React.JSX.Element {
  const { panel, onPanelChange } = props
  function toggle(next: RailPanel): void {
    onPanelChange(panel === next ? null : next)
  }

  return (
    <>
      <nav className="workspace-rail" aria-label="侧边工具">
        <button type="button" className="icon-button" title="设置" aria-label="设置" onClick={props.onSettings}>
          <Settings size={17} />
        </button>
        <button type="button" className={`icon-button ${props.pinned ? 'active' : ''}`}
          title={props.pinned ? '取消固定展开' : '固定展开'} aria-label="固定展开" aria-pressed={props.pinned}
          onClick={props.onPin}>
          {props.pinned ? <PinOff size={17} /> : <Pin size={17} />}
        </button>
        <button type="button" className={`icon-button ${panel === 'todos' ? 'active' : ''}`}
          title="待办事项" aria-label="待办事项" aria-expanded={panel === 'todos'} aria-controls={panel === 'todos' ? 'workspace-panel' : undefined} onClick={() => toggle('todos')}>
          <ClipboardList size={17} />
        </button>
        <button type="button" className={`icon-button rail-conversations ${panel === 'conversations' ? 'active' : ''}`}
          title="切换会话" aria-label="切换会话" aria-expanded={panel === 'conversations'} aria-controls={panel === 'conversations' ? 'workspace-panel' : undefined} onClick={() => toggle('conversations')}>
          <BookOpen size={17} />
        </button>
        <button type="button" className={`icon-button rail-quota ${panel === 'quota' ? 'active' : ''}`}
          title="余额与额度" aria-label="余额与额度" aria-expanded={panel === 'quota'} aria-controls={panel === 'quota' ? 'workspace-panel' : undefined} onClick={() => toggle('quota')}>
          <Wallet size={17} />
        </button>
      </nav>
      {panel && (
        <aside id="workspace-panel" className="workspace-panel" aria-label={panelTitles[panel]} onKeyDown={(event) => {
          if (event.key === 'Escape') onPanelChange(null)
        }}>
          <header className="workspace-panel-header">
            <h2>{panelTitles[panel]}</h2>
            <button type="button" className="icon-button small" title="关闭侧栏" aria-label="关闭侧栏" onClick={() => onPanelChange(null)}>
              <X size={16} />
            </button>
          </header>
          {panel === 'conversations' && <ConversationList {...props} />}
          {panel === 'todos' && <TodoList />}
          {panel === 'quota' && <QuotaPanel providers={props.providers} activeProvider={props.activeProvider} />}
        </aside>
      )}
    </>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ConversationList({ projects, activeProjectId, onActivate, onCreate, onDelete }: WorkspaceRailProps): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run(task: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError('')
    try { await task() }
    catch (err) { setError(errorText(err)) }
    finally { setBusy(false) }
  }

  return (
    <>
      <div className="workspace-panel-controls">
        <button type="button" className="soft-button" aria-expanded={creating} onClick={() => setCreating(!creating)}>
          <Plus size={14} /> 新建会话
        </button>
        {creating && (
          <form className="rail-form" onSubmit={(event) => {
            event.preventDefault()
            if (title.trim() && !busy) void run(() => onCreate(title, author))
          }}>
            <input aria-label="文献标题" placeholder="文献标题" value={title} onChange={(event) => setTitle(event.target.value)} required />
            <input aria-label="作者" placeholder="作者（可选）" value={author} onChange={(event) => setAuthor(event.target.value)} />
            <button type="submit" className="primary-button" disabled={!title.trim() || busy}>创建</button>
          </form>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      <div className="workspace-panel-scroll rail-conversation-list">
        {projects.map((project) => (
          <div key={project.id} className={`rail-conversation ${project.id === activeProjectId ? 'active' : ''}`}>
            <button type="button" className="rail-conversation-select" title={project.title}
              aria-current={project.id === activeProjectId ? 'true' : undefined}
              disabled={busy} onClick={() => void run(() => onActivate(project.id))}>
              <strong>{project.title}</strong>
              {project.author && <span>{project.author}</span>}
            </button>
            {project.kind !== 'english' && (
              <button type="button" className="mini-icon danger" title="删除会话"
                aria-label={`删除 ${project.title}`} disabled={busy} onClick={() => void run(() => onDelete(project))}>
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

function TodoList(): React.JSX.Element {
  const [items, setItems] = useState<TodoItem[]>([])
  const [title, setTitle] = useState('')
  const [editing, setEditing] = useState<TodoItem | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void window.margin.todos.list().then((next) => {
      if (alive) setItems(next)
    }, (err: unknown) => {
      if (alive) setError(errorText(err))
    }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [])

  async function mutate(action: () => Promise<void>, optimistic?: TodoItem[]): Promise<void> {
    setBusy(true)
    setError('')
    if (optimistic) setItems(optimistic)
    try { await action(); setItems(await window.margin.todos.list()) }
    catch (err) {
      if (optimistic) setItems(items)
      setError(errorText(err))
    }
    finally { setBusy(false) }
  }

  return (
    <>
      <div className="workspace-panel-controls">
        <form className="rail-inline-form" onSubmit={(event) => {
          event.preventDefault()
          if (!title.trim() || busy) return
          void mutate(async () => {
            if (editing) await window.margin.todos.update(editing.id, { title })
            else await window.margin.todos.add(title)
            setTitle('')
            setEditing(null)
          })
        }}>
          <input aria-label={editing ? '编辑待办' : '新待办'} placeholder={editing ? '编辑待办' : '添加待办'}
            maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
          <button type="submit" className="icon-button" title={editing ? '保存待办' : '添加待办'}
            aria-label={editing ? '保存待办' : '添加待办'} disabled={busy || !title.trim()}>
            {editing ? <Check size={16} /> : <Plus size={16} />}
          </button>
          {editing && (
            <button type="button" className="icon-button" aria-label="取消编辑" title="取消编辑" onClick={() => {
              setEditing(null)
              setTitle('')
            }}><X size={15} /></button>
          )}
        </form>
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      <div className="workspace-panel-scroll">
        {!busy && !items.length && !error && <p className="rail-empty">暂无待办</p>}
        {items.map((item) => (
          <div key={item.id} className={`rail-todo ${item.completed ? 'completed' : ''}`}>
            <label>
              <input type="checkbox" checked={item.completed} disabled={busy}
                onChange={(event) => {
                  const completed = event.target.checked
                  const next = items.map((current) => current.id === item.id ? { ...current, completed } : current)
                  void mutate(async () => { await window.margin.todos.update(item.id, { completed }) }, next)
                }} />
              <span>{item.title}</span>
            </label>
            <button type="button" className="mini-icon" title="编辑待办" aria-label={`编辑 ${item.title}`} disabled={busy}
              onClick={() => { setEditing(item); setTitle(item.title) }}><Pencil size={13} /></button>
            <button type="button" className="mini-icon danger" title="删除待办" aria-label={`删除 ${item.title}`} disabled={busy}
              onClick={() => void mutate(async () => {
                await window.margin.todos.remove(item.id)
                if (editing?.id === item.id) { setEditing(null); setTitle('') }
              })}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
    </>
  )
}

function QuotaPanel({ providers, activeProvider }: { providers: ApiProvider[]; activeProvider: ApiProvider | null }): React.JSX.Element {
  const deepSeekProviders = providers.filter(isOfficialDeepSeek)
  const [selected, setSelected] = useState(
    activeProvider && isOfficialDeepSeek(activeProvider) ? activeProvider.id
      : activeProvider?.kind === 'chatgpt' ? 'chatgpt' : deepSeekProviders[0]?.id ?? 'chatgpt'
  )
  const [reload, setReload] = useState(0)
  const [deepSeek, setDeepSeek] = useState<DeepSeekQuota | null>(null)
  const [codex, setCodex] = useState<CodexQuota | null>(null)
  const [error, setError] = useState('')
  const [codexError, setCodexError] = useState('')
  const [codexReload, setCodexReload] = useState(0)
  const selectedProvider = deepSeekProviders.find((provider) => provider.id === selected)
  const deepSeekId = selectedProvider?.id

  useEffect(() => {
    let alive = true
    setError('')
    setDeepSeek(null)
    if (deepSeekId) {
      void window.margin.quota.deepSeek(deepSeekId).then((result) => {
        if (alive) setDeepSeek(result)
      }, (err: unknown) => {
        if (alive) setError(errorText(err))
      })
    }
    return () => { alive = false }
  }, [deepSeekId, reload])

  useEffect(() => {
    if (deepSeekId) return
    let alive = true
    setCodex(null)
    setCodexError('')
    void window.margin.quota.codex().then((result) => {
      if (alive) setCodex(result)
    }, (err: unknown) => {
      if (alive) setCodexError(errorText(err))
    })
    return () => { alive = false }
  }, [deepSeekId, codexReload])

  return (
    <>
      <div className="workspace-panel-controls rail-inline-form">
        <select aria-label="查询额度的提供商" value={selectedProvider?.id ?? 'chatgpt'} onChange={(event) => {
          setDeepSeek(null)
          setError('')
          setSelected(event.target.value)
        }}>
          {deepSeekProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          <option value="chatgpt">ChatGPT</option>
        </select>
        {selectedProvider && <button type="button" className="icon-button" title="刷新余额" aria-label="刷新余额"
          disabled={!deepSeek && !error} onClick={() => setReload(reload + 1)}><RefreshCw size={15} /></button>}
      </div>
      <div className="workspace-panel-scroll rail-quota-content">
        {selectedProvider ? (
          <>
            <dl className="rail-quota-details" aria-live="polite">
              <div><dt>账户余额</dt><dd>{deepSeek?.balances.length ? deepSeek.balances.map(({ currency, total }) =>
                <span key={currency}>{currency} {total}</span>) : deepSeek || error ? '不可用' : '查询中…'}</dd></div>
              <div><dt>今日消耗 · Margin</dt><dd>{deepSeek ? `${deepSeek.today.tokens.toLocaleString()} tokens` : '—'}</dd></div>
            </dl>
            {deepSeek && <p className="rail-empty">{deepSeek.today.requests} 次有用量记录的请求 · 北京时间</p>}
            {(error || deepSeek?.balanceError) && <p className="form-error" role="alert">{error || deepSeek?.balanceError}</p>}
            <a href="https://platform.deepseek.com/usage" target="_blank" rel="noreferrer">查看 DeepSeek 账户账单</a>
          </>
        ) : (
          <>
            <dl className="rail-quota-details" aria-live="polite">
              <QuotaRow label="5 小时剩余额度" value={codex?.fiveHours} />
              <QuotaRow label="1 周剩余额度" value={codex?.week} />
            </dl>
            <p className="rail-empty">从本机 Codex 登录账号读取，使用前请确认与 Margin 连接的是同一账号和工作区。</p>
            <button type="button" className="soft-button" onClick={() => setCodexReload(codexReload + 1)} disabled={!codex && !codexError}>
              <RefreshCw size={14} /> {!codex && !codexError ? '查询中…' : '刷新 Codex 额度'}
            </button>
            {codexError && <p className="form-error" role="alert">{codexError}</p>}
            {codex && !codex.fiveHours && !codex.week && <p className="rail-empty">当前计划未返回这两个额度窗口。</p>}
            <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">打开 ChatGPT 用量</a>
          </>
        )}
      </div>
    </>
  )
}

function QuotaRow({ label, value }: { label: string; value?: QuotaWindow | null }): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ? `${value.remaining.toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '—'}</dd>
      {value?.resetsAt && <small>重置于 {new Date(value.resetsAt).toLocaleString('zh-CN')}</small>}
    </div>
  )
}
