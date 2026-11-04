import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  Pencil,
  Trash2,
  X
} from 'lucide-react'
import type { Folder, FolderKind } from '../../../shared/types'
import { Modal } from './Modal'
import {
  buildFolderTree,
  countFolderItems,
  type FolderFilter,
  type FolderNode
} from '../folderUtils'

interface FolderTreeModalProps {
  kind: FolderKind
  folders: Folder[]
  items: Array<{ folderId: string | null }>
  selected: FolderFilter
  mode: 'browse' | 'pick'
  onSelect: (filter: FolderFilter) => void
  onCreate: (parentId: string | null, name: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}

export function FolderTreeModal({
  kind,
  folders,
  items,
  selected,
  mode,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onClose
}: FolderTreeModalProps): React.JSX.Element {
  const tree = useMemo(() => buildFolderTree(folders), [folders])
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(tree.map((node) => node.id))
  )
  const [creating, setCreating] = useState<{ parentId: string | null; name: string } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  function toggle(id: string): void {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function choose(filter: FolderFilter): void {
    onSelect(filter)
    onClose()
  }

  async function submitCreate(): Promise<void> {
    if (!creating?.name.trim()) return
    await onCreate(creating.parentId, creating.name.trim())
    setCreating(null)
  }

  async function submitRename(): Promise<void> {
    if (!renaming?.name.trim()) return
    await onRename(renaming.id, renaming.name.trim())
    setRenaming(null)
  }

  function removeFolder(folder: Folder): void {
    const count = countFolderItems(items, folders, folder.id)
    const message = count
      ? `删除文件夹“${folder.name}”？其中 ${count} 条内容会移到上一级。`
      : `删除空文件夹“${folder.name}”？`
    if (!window.confirm(message)) return
    void onDelete(folder.id)
  }

  function renderNode(node: FolderNode, depth: number): React.JSX.Element {
    const isExpanded = expanded.has(node.id)
    const count = countFolderItems(items, folders, node.id)
    return (
      <div key={node.id} className="folder-node">
        <div
          className={`folder-row ${selected === node.id ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 15 }}
        >
          <button
            className="folder-expand"
            onClick={() => toggle(node.id)}
            disabled={node.children.length === 0}
            type="button"
          >
            {node.children.length ? (
              isExpanded ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )
            ) : (
              <span className="folder-spacer" />
            )}
          </button>
          {renaming?.id === node.id ? (
            <input
              className="folder-inline-input"
              value={renaming.name}
              onChange={(event) => setRenaming({ id: node.id, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitRename()
                if (event.key === 'Escape') setRenaming(null)
              }}
              autoFocus
            />
          ) : (
            <button className="folder-name" onClick={() => choose(node.id)} type="button">
              <FolderIcon size={14} />
              <span>{node.name}</span>
              <em>{count}</em>
            </button>
          )}
          {renaming?.id === node.id && (
            <div className="folder-row-actions">
              <button className="mini-icon" onClick={() => void submitRename()} title="保存">
                <ChevronRight size={13} />
              </button>
              <button className="mini-icon" onClick={() => setRenaming(null)} title="取消">
                <X size={13} />
              </button>
            </div>
          )}
          {mode === 'browse' && renaming?.id !== node.id && (
            <div className="folder-row-actions">
              <button
                className="mini-icon"
                title="新建子文件夹"
                onClick={() => setCreating({ parentId: node.id, name: '' })}
              >
                <FolderPlus size={13} />
              </button>
              <button
                className="mini-icon"
                title="重命名"
                onClick={() => setRenaming({ id: node.id, name: node.name })}
              >
                <Pencil size={12} />
              </button>
              <button
                className="mini-icon danger"
                title="删除文件夹"
                onClick={() => removeFolder(node)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}
        </div>
        {creating?.parentId === node.id && (
          <div className="folder-create-row" style={{ paddingLeft: 28 + depth * 15 }}>
            <input
              value={creating.name}
              onChange={(event) => setCreating({ parentId: node.id, name: event.target.value })}
              placeholder="子文件夹名称"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitCreate()
                if (event.key === 'Escape') setCreating(null)
              }}
              autoFocus
            />
            <button className="mini-icon" onClick={() => void submitCreate()} title="创建">
              <ChevronRight size={13} />
            </button>
            <button className="mini-icon" onClick={() => setCreating(null)} title="取消">
              <X size={13} />
            </button>
          </div>
        )}
        {isExpanded && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  return (
    <Modal
      title={mode === 'pick' ? '移动到文件夹' : kind === 'note' ? '笔记文件夹' : '生词文件夹'}
      subtitle={
        mode === 'pick'
          ? '选择目标文件夹，内容会立即移动。'
          : '文件夹可以嵌套，例如书名 → 章节。'
      }
      onClose={onClose}
      wide
    >
      <div className="folder-picker">
        <div className="folder-quick-row">
          {mode === 'browse' && (
            <button
              className={`folder-quick ${selected === 'all' ? 'active' : ''}`}
              onClick={() => choose('all')}
            >
              全部 <em>{items.length}</em>
            </button>
          )}
          <button
            className={`folder-quick ${selected === 'uncategorized' ? 'active' : ''}`}
            onClick={() => choose('uncategorized')}
          >
            未分类 <em>{items.filter((item) => !item.folderId).length}</em>
          </button>
          {mode === 'browse' && (
            <button
              className="folder-quick add"
              onClick={() => setCreating({ parentId: null, name: '' })}
            >
              <FolderPlus size={14} />
              新建书名文件夹
            </button>
          )}
        </div>

        <div className="folder-tree">
          {tree.length === 0 ? (
            <div className="folder-empty">还没有文件夹。先新建一个书名文件夹。</div>
          ) : (
            tree.map((node) => renderNode(node, 0))
          )}
        </div>

        {creating?.parentId === null && (
          <div className="folder-create-row root">
            <input
              value={creating.name}
              onChange={(event) => setCreating({ parentId: null, name: event.target.value })}
              placeholder="书名 / 主题文件夹名称"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitCreate()
                if (event.key === 'Escape') setCreating(null)
              }}
              autoFocus
            />
            <button className="primary-button compact" onClick={() => void submitCreate()}>
              创建
            </button>
            <button className="ghost-button compact" onClick={() => setCreating(null)}>
              取消
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
