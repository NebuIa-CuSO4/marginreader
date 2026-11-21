import { useState } from 'react'
import { Plus, Settings2, Trash2 } from 'lucide-react'
import type { ApiProvider, ApiStatus, Project } from '../../../shared/types'
import { Modal } from './Modal'

interface ProjectsModalProps {
  projects: Project[]
  activeProjectId: string
  provider: ApiProvider | null
  model: string
  status: ApiStatus
  onActivate: (projectId: string) => Promise<void>
  onCreate: (title: string, author: string) => Promise<void>
  onDelete: (project: Project) => Promise<void>
  onOpenSettings: () => void
  onClose: () => void
}

export function ProjectsModal({
  projects,
  activeProjectId,
  provider,
  model,
  status,
  onActivate,
  onCreate,
  onDelete,
  onOpenSettings,
  onClose
}: ProjectsModalProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
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
    <Modal
      title="阅读项目"
      subtitle="每个文献项目使用一条独立的 API 对话；英语阅读共用一条。"
      onClose={onClose}
      wide
    >
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
              <p>当前项目使用固定 API 对话，消息历史会持续累积。</p>
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

          <div className={`binding-card ${status.phase === 'ready' ? 'connected' : status.phase}`}>
            <div className="binding-text">
              <strong>{provider?.name ?? '尚未配置 API'}</strong>
              <span>{model || '未选择模型'} · {status.message}</span>
            </div>
            <span className={`status-dot ${status.phase}`} />
          </div>

          <div className="binding-actions">
            <button className="soft-button" onClick={onOpenSettings}>
              <Settings2 size={15} />
              配置 API / 模型
            </button>
          </div>

          <div className="new-project">
            <h4>新建文献项目</h4>
            <div className="inline-form">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="书名 / 论文标题"
              />
              <input
                value={author}
                onChange={(event) => setAuthor(event.target.value)}
                placeholder="作者（可选）"
              />
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
