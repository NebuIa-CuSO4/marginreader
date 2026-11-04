import { useState } from 'react'
import { Eye, Pencil } from 'lucide-react'
import type { Folder, Note, NoteTypeDefinition } from '../../../shared/types'
import { Modal } from './Modal'
import { Markdown } from './Markdown'
import { buildFolderTree, type FolderNode } from '../folderUtils'

function flattenFolders(nodes: FolderNode[], depth = 0): Array<{ id: string; label: string }> {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${'　'.repeat(depth)}${depth ? '└ ' : ''}${node.name}` },
    ...flattenFolders(node.children, depth + 1)
  ])
}

export function NoteEditorModal({
  initial,
  projectId,
  folders,
  noteTypes,
  onClose,
  onSave
}: {
  initial?: Partial<Note>
  projectId: string
  folders: Folder[]
  noteTypes: NoteTypeDefinition[]
  onClose: () => void
  onSave: (note: Partial<Note> & { projectId: string; title: string }) => Promise<void>
}): React.JSX.Element {
  const defaultType = noteTypes.find((type) => type.name === initial?.notebook) ?? noteTypes[0]
  const [title, setTitle] = useState(initial?.title ?? '')
  const [noteTypeId, setNoteTypeId] = useState(initial?.noteTypeId ?? defaultType?.id ?? '')
  const [folderId, setFolderId] = useState(initial?.folderId ?? '')
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '))
  const [content, setContent] = useState(initial?.content ?? '')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [saving, setSaving] = useState(false)
  const folderOptions = flattenFolders(buildFolderTree(folders))
  const selectedType = noteTypes.find((type) => type.id === noteTypeId)

  async function submit(): Promise<void> {
    if (!title.trim() || saving) return
    setSaving(true)
    try {
      await onSave({
        id: initial?.id,
        projectId,
        folderId: folderId || null,
        noteTypeId: noteTypeId || null,
        notebook: selectedType?.name ?? initial?.notebook ?? '文献笔记',
        type: 'note',
        title,
        content,
        tags: tags
          .split(/[,，]/)
          .map((tag) => tag.trim().replace(/^#/, ''))
          .filter(Boolean),
        source: initial?.source ?? ''
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={initial?.id ? '编辑笔记' : '新建笔记'}
      subtitle="把理解写成自己的话，之后才找得回来。"
      onClose={onClose}
      wide
    >
      <div className="form-grid">
        <label className="field">
          <span>标题</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>类型</span>
          <select value={noteTypeId} onChange={(event) => setNoteTypeId(event.target.value)}>
            {noteTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>文件夹</span>
          <select value={folderId} onChange={(event) => setFolderId(event.target.value)}>
            <option value="">未分类</option>
            {folderOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field full">
          <span>标签（逗号分隔）</span>
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="例如：认知科学, 隐喻, 第三章"
          />
        </label>
        <div className="field full">
          <div className="note-editor-tabs">
            <span>正文（支持 Markdown 和公式）</span>
            <div className="segmented">
              <button
                className={mode === 'edit' ? 'active' : ''}
                onClick={() => setMode('edit')}
                type="button"
              >
                <Pencil size={13} />
                编辑
              </button>
              <button
                className={mode === 'preview' ? 'active' : ''}
                onClick={() => setMode('preview')}
                type="button"
              >
                <Eye size={13} />
                预览
              </button>
            </div>
          </div>
          {mode === 'edit' ? (
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={9}
              placeholder="原文摘录、你的理解、仍然不明白的问题…"
            />
          ) : (
            <div className="note-editor-preview">
              {content.trim() ? (
                <Markdown content={content} />
              ) : (
                <span className="note-preview-empty">还没有正文内容。</span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="modal-actions">
        <button className="ghost-button" onClick={onClose}>
          取消
        </button>
        <button className="primary-button" onClick={() => void submit()} disabled={!title.trim() || saving}>
          {saving ? '保存中…' : '保存笔记'}
        </button>
      </div>
    </Modal>
  )
}
