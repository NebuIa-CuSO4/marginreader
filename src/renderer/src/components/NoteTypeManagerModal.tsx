import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { NoteTypeDefinition } from '../../../shared/types'
import { Modal } from './Modal'

export function NoteTypeManagerModal({
  noteTypes,
  onSave,
  onRemove,
  onClose
}: {
  noteTypes: NoteTypeDefinition[]
  onSave: (name: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function add(): Promise<void> {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await onSave(name.trim())
      setName('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="笔记类型" subtitle="类型是“文献笔记 / 概念卡片”这一维，和文件夹互不影响。" onClose={onClose}>
      <div className="note-type-list">
        {noteTypes.map((type) => (
          <div key={type.id} className="note-type-row">
            <span className="note-type-dot" style={type.color ? { background: type.color } : undefined} />
            <span>{type.name}</span>
            <button
              className="mini-icon danger"
              title="删除类型"
              onClick={() => {
                if (!window.confirm(`删除类型“${type.name}”？使用它的笔记会变成未分类。`)) return
                void onRemove(type.id)
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="note-type-add">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="新类型名称，例如：人物分析"
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add()
          }}
        />
        <button className="primary-button" onClick={() => void add()} disabled={!name.trim() || busy}>
          <Plus size={14} />
          添加
        </button>
      </div>
    </Modal>
  )
}
