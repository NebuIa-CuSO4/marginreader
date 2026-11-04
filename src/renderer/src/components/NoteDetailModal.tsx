import { FolderInput, Pencil, StickyNote, Trash2 } from 'lucide-react'
import type { Folder, Note } from '../../../shared/types'
import { Modal } from './Modal'
import { Markdown } from './Markdown'
import { folderPath } from '../folderUtils'

function formatDate(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function NoteDetailModal({
  note,
  folders,
  onClose,
  onEdit,
  onMove,
  onDelete
}: {
  note: Note
  folders: Folder[]
  onClose: () => void
  onEdit: (note: Note) => void
  onMove: (note: Note) => void
  onDelete: (note: Note) => void
}): React.JSX.Element {
  const path = folderPath(folders, note.folderId)
  return (
    <Modal title={note.title || '未命名笔记'} subtitle={note.notebook} onClose={onClose} wide>
      <div className="note-detail">
        <div className="note-detail-meta">
          <span>{formatDate(note.updatedAt)}</span>
          {note.tags.length > 0 && (
            <div className="tag-row">
              {note.tags.map((tag) => (
                <span key={tag} className="tag">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="note-detail-source">
          文件夹：{path.length ? path.map((item) => item.name).join(' / ') : '未分类'}
        </div>
        {note.source && <div className="note-detail-source">来源：{note.source}</div>}
        <div className="note-detail-body">
          {note.content.trim() ? (
            <Markdown content={note.content} />
          ) : (
            <div className="note-detail-empty">
              <StickyNote size={22} />
              <span>这条笔记还没有正文。</span>
            </div>
          )}
        </div>
      </div>
      <div className="modal-actions note-detail-actions">
        <button className="ghost-button danger-text" onClick={() => onDelete(note)}>
          <Trash2 size={14} />
          删除
        </button>
        <div className="note-detail-actions-right">
          <button className="ghost-button" onClick={() => onMove(note)}>
            <FolderInput size={14} />
            移动
          </button>
          <button className="ghost-button" onClick={onClose}>
            关闭
          </button>
          <button className="primary-button" onClick={() => onEdit(note)}>
            <Pencil size={14} />
            编辑
          </button>
        </div>
      </div>
    </Modal>
  )
}
