import { useState } from 'react'
import type { Folder, Vocab } from '../../../shared/types'
import { Modal } from './Modal'
import { buildFolderTree, type FolderNode } from '../folderUtils'

function flattenFolders(nodes: FolderNode[], depth = 0): Array<{ id: string; label: string }> {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${'　'.repeat(depth)}${depth ? '└ ' : ''}${node.name}` },
    ...flattenFolders(node.children, depth + 1)
  ])
}

export function VocabEditorModal({
  initial,
  projectId,
  folders,
  onClose,
  onSave
}: {
  initial?: Partial<Vocab>
  projectId: string
  folders: Folder[]
  onClose: () => void
  onSave: (item: Partial<Vocab> & { projectId: string; word: string }) => Promise<void>
}): React.JSX.Element {
  const [word, setWord] = useState(initial?.word ?? '')
  const [folderId, setFolderId] = useState(initial?.folderId ?? '')
  const [phonetic, setPhonetic] = useState(initial?.phonetic ?? '')
  const [meaning, setMeaning] = useState(initial?.meaning ?? '')
  const [example, setExample] = useState(initial?.example ?? '')
  const [source, setSource] = useState(initial?.source ?? '')
  const [saving, setSaving] = useState(false)
  const folderOptions = flattenFolders(buildFolderTree(folders))

  async function submit(): Promise<void> {
    if (!word.trim() || saving) return
    setSaving(true)
    try {
      await onSave({
        id: initial?.id,
        projectId,
        folderId: folderId || null,
        word,
        phonetic,
        meaning,
        example,
        source
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={initial?.id ? '编辑生词' : '添加生词'} subtitle="单词 + 原句 + 出处，比只记中文释义更有用。" onClose={onClose}>
      <div className="form-grid">
        <label className="field">
          <span>单词 / 短语</span>
          <input value={word} onChange={(event) => setWord(event.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>音标</span>
          <input value={phonetic} onChange={(event) => setPhonetic(event.target.value)} placeholder="/ˈmɑːdʒɪn/" />
        </label>
        <label className="field full">
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
          <span>释义</span>
          <textarea value={meaning} onChange={(event) => setMeaning(event.target.value)} rows={3} />
        </label>
        <label className="field full">
          <span>原句</span>
          <textarea value={example} onChange={(event) => setExample(event.target.value)} rows={3} />
        </label>
        <label className="field full">
          <span>出处</span>
          <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="书名、章节、网页对话" />
        </label>
      </div>
      <div className="modal-actions">
        <button className="ghost-button" onClick={onClose}>
          取消
        </button>
        <button className="primary-button" onClick={() => void submit()} disabled={!word.trim() || saving}>
          {saving ? '保存中…' : '保存生词'}
        </button>
      </div>
    </Modal>
  )
}
