import { useMemo, useState } from 'react'
import {
  FolderInput,
  FolderTree,
  Pencil,
  Plus,
  Search,
  Settings2,
  StickyNote,
  Trash2
} from 'lucide-react'
import type { Folder, Note, NoteTypeDefinition, Project } from '../../../shared/types'
import { filterByFolder, folderPath, type FolderFilter } from '../folderUtils'

interface NotesViewProps {
  notes: Note[]
  folders: Folder[]
  noteTypes: NoteTypeDefinition[]
  projects: Project[]
  selectedFolder: FolderFilter
  onSelectFolder: () => void
  onManageTypes: () => void
  onNew: () => void
  onOpen: (note: Note) => void
  onEdit: (note: Note) => void
  onMove: (note: Note) => void
  onDelete: (note: Note) => void
}

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function excerpt(content: string): string {
  return content
    .replace(/\$\$[\s\S]*?\$\$/g, '［公式］')
    .replace(/\\\[[\s\S]*?\\\]/g, '［公式］')
    .replace(/\$[^$\n]{1,120}\$/g, '［公式］')
    .replace(/[#>*`_\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export function NotesView({
  notes,
  folders,
  noteTypes,
  projects,
  selectedFolder,
  onSelectFolder,
  onManageTypes,
  onNew,
  onOpen,
  onEdit,
  onMove,
  onDelete
}: NotesViewProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const currentPath = folderPath(
    folders,
    selectedFolder === 'all' || selectedFolder === 'uncategorized' ? null : selectedFolder
  )
  const folderLabel =
    selectedFolder === 'all'
      ? '全部笔记'
      : selectedFolder === 'uncategorized'
        ? '未分类'
        : currentPath.map((item) => item.name).join(' / ')

  const visible = useMemo(() => {
    const byFolder = filterByFolder(notes, folders, selectedFolder)
    const q = query.trim().toLowerCase()
    return byFolder.filter((note) => {
      if (typeFilter !== 'all' && note.noteTypeId !== typeFilter) return false
      if (!q) return true
      const project = projects.find((item) => item.id === note.projectId)?.title ?? ''
      return [note.title, note.content, note.notebook, note.tags.join(' '), project]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [notes, folders, selectedFolder, query, typeFilter, projects])

  return (
    <section className="list-view">
      <div className="list-toolbar">
        <div className="search-box">
          <Search size={15} />
          <input
            value={query}
            placeholder="搜索笔记、标签、类型…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button className="primary-icon-button" onClick={onNew} title="新建笔记">
          <Plus size={17} />
        </button>
      </div>

      <div className="folder-bar">
        <button className="folder-path-button" onClick={onSelectFolder}>
          <FolderTree size={14} />
          <span>{folderLabel}</span>
          <em>{visible.length}</em>
        </button>
        <select
          className="type-filter-select"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          title="按类型筛选"
        >
          <option value="all">全部类型</option>
          {noteTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        <button className="mini-icon" title="管理笔记类型" onClick={onManageTypes}>
          <Settings2 size={14} />
        </button>
      </div>

      <div className="list-scroll">
        {visible.length === 0 ? (
          <div className="list-empty">
            <StickyNote size={28} />
            <h3>{query ? '没有匹配的笔记' : '这个文件夹还没有笔记'}</h3>
            <p>可以把笔记移动到其他文件夹，或换一个筛选条件。</p>
            <button className="soft-button" onClick={onNew}>
              <Plus size={15} />
              新建笔记
            </button>
          </div>
        ) : (
          visible.map((note) => {
            const type = noteTypes.find((item) => item.id === note.noteTypeId)
            const project = projects.find((item) => item.id === note.projectId)
            return (
              <article key={note.id} className="note-card" onClick={() => onOpen(note)}>
                <div className="note-card-head">
                  <span className="notebook-label">{type?.name ?? note.notebook}</span>
                  <span className="note-date">{formatDate(note.updatedAt)}</span>
                </div>
                <h3>{note.title}</h3>
                <p>{excerpt(note.content) || '空白笔记'}</p>
                <div className="note-card-foot">
                  <div className="tag-row">
                    {project && <span className="source-label">{project.title}</span>}
                    {note.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="tag">
                        #{tag}
                      </span>
                    ))}
                  </div>
                  <div className="note-actions">
                    <button
                      className="mini-icon"
                      title="移动"
                      onClick={(event) => {
                        event.stopPropagation()
                        onMove(note)
                      }}
                    >
                      <FolderInput size={13} />
                    </button>
                    <button
                      className="mini-icon"
                      title="编辑"
                      onClick={(event) => {
                        event.stopPropagation()
                        onEdit(note)
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="mini-icon danger"
                      title="删除"
                      onClick={(event) => {
                        event.stopPropagation()
                        onDelete(note)
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </article>
            )
          })
        )}
      </div>
    </section>
  )
}
