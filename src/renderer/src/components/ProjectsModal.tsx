import { useState } from 'react'
import { ExternalLink, Link2, Plus, Trash2 } from 'lucide-react'
import type {
  ConversationBinding,
  DeepSeekStatus,
  Project
} from '../../../shared/types'
import { Modal } from './Modal'

interface ProjectsModalProps {
  projects: Project[]
  activeProjectId: string
  binding: ConversationBinding | null
  status: DeepSeekStatus
  onActivate: (projectId: string) => Promise<void>
  onCreate: (title: string, author: string) => Promise<void>
  onDelete: (project: Project) => Promise<void>
  onBindCurrent: () => Promise<void>
  onBindUrl: (url: string) => Promise<void>
  onOpenWeb: () => void
  onClose: () => void
}

function bindingLabel(binding: ConversationBinding | null): string {
  if (!binding) return '尚未绑定网页对话'
  if (binding.status === 'connected') return '已绑定网页对话'
  if (binding.status === 'unbound') return '已发送，但未捕获对话 ID'
  if (binding.status === 'login_required') return '需要重新登录'
  if (binding.status === 'missing') return '网页对话不存在'
  if (binding.status === 'mismatch') return '网页对话与绑定不一致'
  return '尚未连接'
}

export function ProjectsModal({
  projects,
  activeProjectId,
  binding,
  status,
  onActivate,
  onCreate,
  onDelete,
  onBindCurrent,
  onBindUrl,
  onOpenWeb,
  onClose
}: ProjectsModalProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = projects.find((project) => project.id === activeProjectId)

  async function run(task: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="阅读项目" subtitle="文献项目各自绑定一条网页对话；英语阅读共用一条。" onClose={onClose} wide>
      <div className="project-layout">
        <div className="project-list">
          {projects.map((project) => (
            <button
              key={project.id}
              className={`project-row ${project.id === activeProjectId ? 'active' : ''}`}
              onClick={() => void run(() => onActivate(project.id))}
            >
              <div>
                <strong>{project.title}</strong>
                <span>{project.kind === 'english' ? '英语 · 共用对话' : project.author || '文献'}</span>
              </div>
              {project.id === activeProjectId && <span className="active-dot" />}
            </button>
          ))}
        </div>

        <div className="project-detail">
          <div className="detail-head">
            <div>
              <h3>{active?.title ?? '选择项目'}</h3>
              <p>{active?.kind === 'english' ? '所有英语文章共用这一条 DeepSeek 对话。' : '这个文献项目固定使用一条 DeepSeek 对话。'}</p>
            </div>
            {active && active.id !== 'english-reading' && (
              <button
                className="mini-icon danger"
                title="删除项目"
                onClick={() => {
                  if (active) void run(() => onDelete(active))
                }}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>

          <div className={`binding-card ${binding?.status ?? 'none'}`}>
            <div className="binding-text">
              <strong>{bindingLabel(binding)}</strong>
              <span>{binding?.externalId ? `对话 ID · ${binding.externalId.slice(0, 16)}…` : status.message}</span>
            </div>
            <span className={`status-dot ${status.phase}`} />
          </div>

          <div className="binding-actions">
            <button className="soft-button" onClick={onOpenWeb}>
              <ExternalLink size={15} />
              打开网页
            </button>
            <button className="soft-button" onClick={() => void run(onBindCurrent)} disabled={busy}>
              <Link2 size={15} />
              绑定当前网页对话
            </button>
          </div>

          <div className="url-bind">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="粘贴已有 DeepSeek 对话链接…"
            />
            <button
              className="ghost-button"
              onClick={() => void run(() => onBindUrl(url))}
              disabled={!url.trim() || busy}
            >
              绑定链接
            </button>
          </div>

          <div className="new-project">
            <h4>新建文献项目</h4>
            <div className="inline-form">
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="书名 / 论文标题" />
              <input value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="作者（可选）" />
              <button
                className="primary-button"
                disabled={!title.trim() || busy}
                onClick={() => {
                  void run(async () => {
                    await onCreate(title, author)
                    setTitle('')
                    setAuthor('')
                  })
                }}
              >
                <Plus size={15} />
                创建
              </button>
            </div>
          </div>

          {error && <div className="form-error">{error}</div>}
        </div>
      </div>
    </Modal>
  )
}
