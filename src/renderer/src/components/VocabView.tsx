import { useMemo, useState } from 'react'
import {
  CheckCircle2,
  FolderInput,
  FolderTree,
  Languages,
  Plus,
  Search,
  Trash2
} from 'lucide-react'
import type { Folder, Project, Vocab } from '../../../shared/types'
import { filterByFolder, folderPath, type FolderFilter } from '../folderUtils'

interface VocabViewProps {
  vocab: Vocab[]
  folders: Folder[]
  projects: Project[]
  selectedFolder: FolderFilter
  onSelectFolder: () => void
  onNew: () => void
  onEdit: (item: Vocab) => void
  onMove: (item: Vocab) => void
  onReview: (item: Vocab) => void
  onDelete: (item: Vocab) => void
}

export function VocabView({
  vocab,
  folders,
  projects,
  selectedFolder,
  onSelectFolder,
  onNew,
  onEdit,
  onMove,
  onReview,
  onDelete
}: VocabViewProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const currentPath = folderPath(
    folders,
    selectedFolder === 'all' || selectedFolder === 'uncategorized' ? null : selectedFolder
  )
  const folderLabel =
    selectedFolder === 'all'
      ? '全部生词'
      : selectedFolder === 'uncategorized'
        ? '未分类'
        : currentPath.map((item) => item.name).join(' / ')

  const visible = useMemo(() => {
    const byFolder = filterByFolder(vocab, folders, selectedFolder)
    const q = query.trim().toLowerCase()
    if (!q) return byFolder
    return byFolder.filter((item) => {
      const project = projects.find((entry) => entry.id === item.projectId)?.title ?? ''
      return [item.word, item.phonetic, item.meaning, item.example, item.source, project]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [vocab, folders, selectedFolder, query, projects])

  return (
    <section className="list-view">
      <div className="list-toolbar">
        <div className="search-box">
          <Search size={15} />
          <input
            value={query}
            placeholder="搜索单词、释义、出处…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button className="primary-icon-button" onClick={onNew} title="添加生词">
          <Plus size={17} />
        </button>
      </div>

      <div className="folder-bar">
        <button className="folder-path-button" onClick={onSelectFolder}>
          <FolderTree size={14} />
          <span>{folderLabel}</span>
          <em>{visible.length}</em>
        </button>
      </div>

      <div className="list-scroll">
        {visible.length === 0 ? (
          <div className="list-empty">
            <Languages size={28} />
            <h3>{query ? '没有匹配的生词' : '这个文件夹还没有生词'}</h3>
            <p>划词时点“存生词”，或在这里手动添加。可以把不同书籍放进不同文件夹。</p>
            <button className="soft-button" onClick={onNew}>
              <Plus size={15} />
              添加生词
            </button>
          </div>
        ) : (
          visible.map((item) => {
            const project = projects.find((entry) => entry.id === item.projectId)
            return (
              <article key={item.id} className="vocab-card" onClick={() => onEdit(item)}>
                <div className="vocab-head">
                  <div>
                    <h3>{item.word}</h3>
                    {item.phonetic && <span className="phonetic">{item.phonetic}</span>}
                  </div>
                  <div className="vocab-actions">
                    <button
                      className="mini-icon"
                      title="移动"
                      onClick={(event) => {
                        event.stopPropagation()
                        onMove(item)
                      }}
                    >
                      <FolderInput size={14} />
                    </button>
                    <button
                      className="mini-icon"
                      title="记录一次复习"
                      onClick={(event) => {
                        event.stopPropagation()
                        onReview(item)
                      }}
                    >
                      <CheckCircle2 size={14} />
                    </button>
                    <button
                      className="mini-icon danger"
                      title="删除"
                      onClick={(event) => {
                        event.stopPropagation()
                        onDelete(item)
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <p className="vocab-meaning">{item.meaning || '还没有释义'}</p>
                {item.example && <p className="vocab-example">“{item.example}”</p>}
                <div className="vocab-foot">
                  <span>{item.reviewCount > 0 ? `已复习 ${item.reviewCount} 次` : '待复习'}</span>
                  <span className="vocab-source">{project?.title ?? item.source}</span>
                </div>
              </article>
            )
          })
        )}
      </div>
    </section>
  )
}
