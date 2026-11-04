import { AlertTriangle, Trash2 } from 'lucide-react'
import type { Project } from '../../../shared/types'
import type { ProjectUsage } from '../../../shared/api'
import { Modal } from './Modal'

export function DeleteProjectModal({
  project,
  usage,
  onConfirm,
  onClose
}: {
  project: Project
  usage: ProjectUsage
  onConfirm: () => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal title="删除阅读项目" subtitle={project.title} onClose={onClose}>
      <div className="danger-note">
        <AlertTriangle size={17} />
        <span>此操作不可恢复。网页端 DeepSeek 对话不会被删除，但本地记录会一起删除。</span>
      </div>
      <div className="delete-usage">
        <div>
          <strong>{usage.notes}</strong>
          <span>条笔记</span>
        </div>
        <div>
          <strong>{usage.vocab}</strong>
          <span>个生词</span>
        </div>
        <div>
          <strong>{usage.messages}</strong>
          <span>条对话消息</span>
        </div>
      </div>
      <div className="modal-actions">
        <button className="ghost-button" onClick={onClose}>
          取消
        </button>
        <button className="danger-button" onClick={() => void onConfirm()}>
          <Trash2 size={14} />
          确认删除
        </button>
      </div>
    </Modal>
  )
}
