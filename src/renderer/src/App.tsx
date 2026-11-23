import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  Languages,
  Loader2,
  MessageSquare,
  NotebookPen,
  PanelRightClose,
  StickyNote,
  Upload
} from 'lucide-react'
import type {
  ApiConversation,
  ApiProvider,
  ApiStatus,
  BootstrapData,
  ChatMessage,
  Folder,
  Note,
  NoteTypeDefinition,
  Project,
  SelectionAction,
  Settings as SettingsType,
  StreamEvent,
  Vocab,
  WindowState
} from '../../shared/types'
import { supportsWebSearch } from '../../shared/types'
import { ChatView } from './components/ChatView'
import { NotesView } from './components/NotesView'
import { VocabView } from './components/VocabView'
import { WorkspacePanel, WorkspaceRail, type RailPanel } from './components/WorkspaceRail'
import { SettingsModal } from './components/SettingsModal'
import { NoteEditorModal } from './components/NoteEditorModal'
import { NoteDetailModal } from './components/NoteDetailModal'
import { NoteTypeManagerModal } from './components/NoteTypeManagerModal'
import { VocabEditorModal } from './components/VocabEditorModal'
import { FolderTreeModal } from './components/FolderTreeModal'
import { DeleteProjectModal } from './components/DeleteProjectModal'
import { Modal } from './components/Modal'
import type { ProjectUsage } from '../../shared/api'
import { parseVocabAnswer, VOCAB_FORMAT_INSTRUCTION } from '../../shared/vocab'
import type { FolderFilter } from './folderUtils'

const EMPTY_STATUS: ApiStatus = {
  phase: 'not_configured',
  message: '尚未配置 API'
}

type Tab = 'chat' | 'notes' | 'vocab'

interface PendingImage {
  dataUrl: string
  width: number
  height: number
}

function statusLabel(status: ApiStatus): string {
  if (status.phase === 'ready') return 'API 已连接'
  if (status.phase === 'offline') return '网络未连接'
  if (status.phase === 'error') return 'API 异常'
  return '未配置 API'
}

function statusClass(status: ApiStatus): string {
  if (status.phase === 'ready') return 'connected'
  if (status.phase === 'offline') return 'warning'
  if (status.phase === 'error') return 'error'
  return 'idle'
}

export default function App(): React.JSX.Element {
  const [booted, setBooted] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState('english-reading')
  const [apiProviders, setApiProviders] = useState<ApiProvider[]>([])
  const [conversation, setConversation] = useState<ApiConversation | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messagesHasMore, setMessagesHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])
  const [vocab, setVocab] = useState<Vocab[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [noteTypes, setNoteTypes] = useState<NoteTypeDefinition[]>([])
  const [notesFolder, setNotesFolder] = useState<FolderFilter>('all')
  const [vocabFolder, setVocabFolder] = useState<FolderFilter>('all')
  const [folderModal, setFolderModal] = useState<'note' | 'vocab' | null>(null)
  const [moveNote, setMoveNote] = useState<Note | null>(null)
  const [moveVocab, setMoveVocab] = useState<Vocab | null>(null)
  const [typesOpen, setTypesOpen] = useState(false)
  const [deleteRequest, setDeleteRequest] = useState<{
    project: Project
    usage: ProjectUsage
  } | null>(null)
  const [settings, setSettings] = useState<SettingsType | null>(null)
  const [status, setStatus] = useState<ApiStatus>(EMPTY_STATUS)
  const [windowState, setWindowState] = useState<WindowState>({
    collapsed: false,
    side: 'right',
    pinned: false
  })
  const [tab, setTab] = useState<Tab>('chat')
  const [composer, setComposer] = useState('')
  const [sending, setSending] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' } | null>(null)
  const [railPanel, setRailPanel] = useState<RailPanel | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [noteDraft, setNoteDraft] = useState<{ initial?: Partial<Note> } | null>(null)
  const [noteView, setNoteView] = useState<Note | null>(null)
  const [vocabDraft, setVocabDraft] = useState<{ initial?: Partial<Vocab> } | null>(null)
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null)
  const [captureChoice, setCaptureChoice] = useState<PendingImage | null>(null)
  const [excerpting, setExcerpting] = useState(false)
  const excerptingRef = useRef(false)

  const activeIdRef = useRef(activeProjectId)
  const conversationRef = useRef<ApiConversation | null>(null)
  const settingsRef = useRef<SettingsType | null>(null)
  const activeSends = useRef(new Map<string, string>())
  const drafts = useRef(new Map<string, { text: string; image: PendingImage | null }>())
  const composerRef = useRef('')
  const toastTimer = useRef<number | null>(null)
  const hideTimer = useRef<number | null>(null)
  const pendingImageRef = useRef<PendingImage | null>(null)

  useEffect(() => {
    activeIdRef.current = activeProjectId
  }, [activeProjectId])
  useEffect(() => {
    conversationRef.current = conversation
  }, [conversation])
  useEffect(() => {
    settingsRef.current = settings
    if (settings) {
      document.documentElement.dataset.theme = settings.theme
    }
  }, [settings])
  function updateComposer(text: string): void {
    composerRef.current = text
    setComposer(text)
  }

  function updatePendingImage(image: PendingImage | null): void {
    pendingImageRef.current = image
    setPendingImage(image)
  }

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId),
    [projects, activeProjectId]
  )
  const activeProvider = useMemo(
    () => apiProviders.find((provider) => provider.id === conversation?.providerId) ?? null,
    [apiProviders, conversation]
  )

  function showToast(text: string, tone: 'info' | 'error' = 'info'): void {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ text, tone })
    toastTimer.current = window.setTimeout(() => setToast(null), 3200)
  }

  function applyBootstrap(data: BootstrapData): void {
    setProjects(data.projects)
    setActiveProjectId(data.activeProjectId)
    activeIdRef.current = data.activeProjectId
    setSending(activeSends.current.has(data.activeProjectId))
    setApiProviders(data.apiProviders)
    setConversation(data.conversation)
    conversationRef.current = data.conversation
    setStatus(data.apiStatus)
    setMessages(data.messages)
    setMessagesHasMore(data.messagesHasMore)
    setLoadingOlder(false)
    setNotes(data.notes)
    setVocab(data.vocab)
    setFolders(data.folders)
    setNoteTypes(data.noteTypes)
    setSettings(data.settings)
    settingsRef.current = data.settings
    setWindowState(data.windowState)
    setBooted(true)
  }

  useEffect(() => {
    let alive = true
    void window.margin.app
      .bootstrap()
      .then((data) => {
        if (!alive) return
        applyBootstrap(data)
      })
      .catch((error) => {
        if (!alive) return
        showToast(`启动失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        setBooted(true)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const offStream = window.margin.chat.onStream((event: StreamEvent) => {
      if (event.projectId !== activeIdRef.current) return
      setMessages((previous) => {
        const index = previous.findIndex((message) => message.id === event.assistantId)
        if (index < 0) {
          if (event.phase === 'delta' || event.phase === 'done') {
            return [
              ...previous,
              {
                id: event.assistantId,
                projectId: event.projectId,
                role: 'assistant',
                content: event.text ?? '',
                reasoning: event.reasoning ?? '',
                searchStatus: event.searchStatus,
                status: event.phase === 'done' ? 'complete' : 'streaming',
                createdAt: Date.now()
              }
            ]
          }
          return previous
        }
        const next = [...previous]
        const message = { ...next[index] }
        if (event.text !== undefined) message.content = event.text
        if (event.reasoning !== undefined) message.reasoning = event.reasoning
        if (event.searchStatus) message.searchStatus = event.searchStatus
        if (event.phase === 'delta') message.status = 'streaming'
        if (event.phase === 'done') message.status = 'complete'
        if (event.phase === 'error') {
          message.status = 'error'
          message.content = event.text || event.error || '回答失败'
        }
        if (event.phase === 'stopped') message.status = 'interrupted'
        next[index] = message
        return next
      })
      if (event.phase === 'error' && event.error) showToast(event.error, 'error')
    })

    const offState = window.margin.window.onStateChange((next) => {
      setWindowState(next)
      setSettings((previous) => (previous ? { ...previous, pinned: next.pinned } : previous))
    })

    const offCapture = window.margin.capture.onResult((result) => {
      if (result.error) {
        showToast(result.error, 'error')
        return
      }
      if (result.imageDataUrl) {
        setCaptureChoice({
          dataUrl: result.imageDataUrl,
          width: result.width,
          height: result.height
        })
        setTab('chat')
        return
      }
      if (result.text.trim()) {
        setTab('chat')
        updateComposer(`屏幕内容：\n${result.text}\n\n我的问题：`)
        showToast('已读取屏幕文字')
        window.setTimeout(
          () => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),
          80
        )
        return
      }
      showToast('截图区域太小，可以换一个区域再试。', 'error')
    })

    const offStatus = window.margin.api.onStatusChange((next) => setStatus(next))

    const offSelection = window.margin.selection.onAction((action) => {
      if (action.action === 'excerpt') {
        void runExcerpt({ text: action.text })
        return
      }
      if (action.action === 'save') {
        setTab('vocab')
        setVocabDraft({
          initial: {
            word: action.text.slice(0, 120),
            source: '划词'
          }
        })
        return
      }
      const prompt =
        action.action === 'translate'
          ? `请把下面这段文字翻译成中文，并指出关键词和语气：\n\n"""${action.text}"""`
          : `请解释下面这段文字的意思、上下文含义和可能的难点：\n\n"""${action.text}"""`
      const sendText = `${prompt}\n\n${VOCAB_FORMAT_INSTRUCTION}`
      setTab('chat')
      updateComposer(sendText)
      void window.margin.window.expand(true)
      const currentSettings = settingsRef.current
      if (currentSettings?.autoSendSelection) {
        const projectId = activeIdRef.current
        window.setTimeout(() => {
          if (activeIdRef.current === projectId && composerRef.current === sendText) {
            void performSend(sendText, action.text)
          }
        }, 120)
      }
    })

    return () => {
      offStream()
      offState()
      offCapture()
      offStatus()
      offSelection()
    }
  }, [])

  async function switchProject(projectId: string): Promise<void> {
    const data = await window.margin.app.activateProject(projectId)
    drafts.current.set(activeIdRef.current, { text: composerRef.current, image: pendingImageRef.current })
    applyBootstrap(data)
    const draft = drafts.current.get(projectId)
    updateComposer(draft?.text ?? '')
    updatePendingImage(draft?.image ?? null)
    setTab('chat')
    setRailPanel(null)
  }

  async function performSend(
    text: string,
    displayText?: string,
    imageDataUrl?: string,
    webSearch = false
  ): Promise<boolean> {
    const clean = text.trim() || (imageDataUrl ? '请看这张截图。' : '')
    const projectId = activeIdRef.current
    if (!clean || activeSends.current.has(projectId)) return false
    if (!conversationRef.current) {
      showToast('请先在设置中配置 API、密钥和模型。', 'error')
      setSettingsOpen(true)
      return false
    }
    const assistantId = crypto.randomUUID()
    const submittedDraft = {
      text: composerRef.current,
      image: imageDataUrl ? pendingImageRef.current : null
    }
    activeSends.current.set(projectId, assistantId)
    updateComposer('')
    if (submittedDraft.image) updatePendingImage(null)

    function restoreDraft(): void {
      if (activeIdRef.current === projectId) {
        if (!composerRef.current) updateComposer(submittedDraft.text)
        if (!pendingImageRef.current && composerRef.current === submittedDraft.text && submittedDraft.image) {
          updatePendingImage(submittedDraft.image)
        }
      } else {
        const draft = drafts.current.get(projectId)
        if (!draft?.text && !draft?.image) drafts.current.set(projectId, submittedDraft)
      }
    }
    const userId = crypto.randomUUID()
    const timestamp = Date.now()
    const shownText = displayText?.trim() || clean
    setMessages((previous) => [
      ...previous,
      {
        id: userId,
        projectId: activeIdRef.current,
        conversationId: conversationRef.current?.id,
        role: 'user',
        content: shownText,
        status: 'sending',
        createdAt: timestamp
      },
      {
        id: assistantId,
        projectId: activeIdRef.current,
        conversationId: conversationRef.current?.id,
        role: 'assistant',
        content: '',
        reasoning: '',
        status: 'streaming',
        createdAt: timestamp + 1
      }
    ])
    setSending(true)
    setTab('chat')
    try {
      const result = await window.margin.chat.send({
        projectId,
        text: clean,
        displayText: shownText,
        assistantId,
        userId,
        imageDataUrl,
        webSearch
      })
      if (!result.ok) restoreDraft()
      if (activeIdRef.current !== projectId) return result.ok
      if (!result.ok) {
        setMessages((previous) =>
          previous.map((message) => {
            if (message.id === userId) return { ...message, status: 'error' }
            if (message.id === assistantId) {
              return { ...message, status: result.code === 'API_ABORTED' ? 'interrupted' : 'error', content: message.content || result.error || '发送失败' }
            }
            return message
          })
        )
        showToast(result.error ?? '发送失败', result.code === 'API_ABORTED' ? 'info' : 'error')
        return false
      }
      setMessages((previous) =>
        previous.map((message) =>
          message.id === userId ? { ...message, status: 'complete' } : message
        )
      )
      return true
    } catch (error) {
      restoreDraft()
      if (activeIdRef.current !== projectId) return false
      const message = error instanceof Error ? error.message : String(error)
      setMessages((previous) =>
        previous.map((item) => {
          if (item.id === userId) return { ...item, status: 'error' }
          if (item.id === assistantId) return { ...item, status: 'error', content: item.content || message }
          return item
        })
      )
      showToast(message, 'error')
      return false
    } finally {
      activeSends.current.delete(projectId)
      if (activeIdRef.current === projectId) setSending(false)
    }
  }

  async function requestSend(webSearch = false): Promise<boolean> {
    const text = composerRef.current.trim()
    const imageDataUrl = pendingImageRef.current?.dataUrl
    if (!text && !imageDataUrl) return false
    const sendText = text || '请看这张截图。'
    return performSend(sendText, undefined, imageDataUrl, webSearch)
  }

  async function stopGeneration(): Promise<void> {
    const projectId = activeIdRef.current
    const assistantId = activeSends.current.get(projectId)
    if (assistantId) await window.margin.chat.stop(projectId, assistantId)
  }

  async function loadOlderMessages(): Promise<void> {
    if (loadingOlder || !messagesHasMore) return
    const oldest = messages[0]
    if (!oldest) return
    const projectId = activeIdRef.current
    setLoadingOlder(true)
    try {
      const page = await window.margin.chat.messages(projectId, {
        createdAt: oldest.createdAt,
        id: oldest.id
      })
      if (activeIdRef.current !== projectId) return
      setMessages((previous) => {
        const known = new Set(previous.map((message) => message.id))
        const older = page.messages.filter((message) => !known.has(message.id))
        return [...older, ...previous]
      })
      setMessagesHasMore(page.hasMore)
    } finally {
      setLoadingOlder(false)
    }
  }

  async function runExcerpt(input: { text?: string; imageDataUrl?: string }): Promise<void> {
    if (excerptingRef.current) return
    excerptingRef.current = true
    setExcerpting(true)
    void window.margin.window.expand(true)
    showToast('正在让模型逐字整理摘抄…')
    try {
      const result = await window.margin.excerpt.run({
        projectId: activeIdRef.current,
        ...input
      })
      setNotes((previous) => [result.note, ...previous.filter((note) => note.id !== result.note.id)])
      setNoteView(result.note)
      setTab('notes')
      showToast(
        result.exact === false
          ? '模型返回内容有改动，已自动改用原文并保存。'
          : '摘抄已保存为笔记'
      )
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      excerptingRef.current = false
      setExcerpting(false)
    }
  }

  async function refreshNotes(): Promise<void> {
    const items = await window.margin.notes.list('')
    setNotes(items)
  }

  async function refreshVocab(): Promise<void> {
    const items = await window.margin.vocab.list('')
    setVocab(items)
  }

  async function refreshFolders(): Promise<Folder[]> {
    const items = await window.margin.folders.list()
    setFolders(items)
    return items
  }

  async function refreshNoteTypes(): Promise<void> {
    setNoteTypes(await window.margin.noteTypes.list())
  }

  async function createFolder(
    kind: 'note' | 'vocab',
    parentId: string | null,
    name: string
  ): Promise<void> {
    await window.margin.folders.create({ kind, parentId, name })
    await refreshFolders()
    showToast('文件夹已创建')
  }

  async function renameFolder(id: string, name: string): Promise<void> {
    await window.margin.folders.rename(id, name)
    await refreshFolders()
  }

  async function removeFolder(id: string): Promise<void> {
    const result = await window.margin.folders.remove(id)
    const remaining = await refreshFolders()
    const valid = new Set(remaining.map((folder) => folder.id))
    if (notesFolder !== 'all' && notesFolder !== 'uncategorized' && !valid.has(notesFolder)) {
      setNotesFolder('all')
    }
    if (vocabFolder !== 'all' && vocabFolder !== 'uncategorized' && !valid.has(vocabFolder)) {
      setVocabFolder('all')
    }
    showToast(
      result.notes + result.vocab > 0
        ? `文件夹已删除，${result.notes + result.vocab} 条内容已移到上一级`
        : '文件夹已删除'
    )
  }

  async function moveNoteTo(note: Note, filter: FolderFilter): Promise<void> {
    if (filter === 'all') return
    await window.margin.notes.save({
      ...note,
      folderId: filter === 'uncategorized' ? null : filter,
      projectId: note.projectId,
      title: note.title
    })
    await refreshNotes()
    showToast('笔记已移动')
  }

  async function moveVocabTo(item: Vocab, filter: FolderFilter): Promise<void> {
    if (filter === 'all') return
    await window.margin.vocab.save({
      ...item,
      folderId: filter === 'uncategorized' ? null : filter,
      projectId: item.projectId,
      word: item.word
    })
    await refreshVocab()
    showToast('生词已移动')
  }

  async function addNoteType(name: string): Promise<void> {
    await window.margin.noteTypes.save({ name })
    await refreshNoteTypes()
    showToast('类型已添加')
  }

  async function removeNoteType(id: string): Promise<void> {
    await window.margin.noteTypes.remove(id)
    await Promise.all([refreshNoteTypes(), refreshNotes()])
    showToast('类型已删除')
  }

  async function requestDeleteProject(project: Project): Promise<void> {
    const usage = await window.margin.app.deleteProjectPreview(project.id)
    setRailPanel(null)
    setDeleteRequest({ project, usage })
  }

  async function saveNote(note: Partial<Note> & { projectId: string; title: string }): Promise<void> {
    await window.margin.notes.save(note)
    await refreshNotes()
    showToast('笔记已保存')
  }

  async function saveVocab(item: Partial<Vocab> & { projectId: string; word: string }): Promise<void> {
    await window.margin.vocab.save(item)
    await refreshVocab()
    showToast('生词已保存')
  }

  function saveVocabFromAnswer(answer: string, question: string): void {
    const parsed = parseVocabAnswer(answer, question)
    setVocabDraft({
      initial: {
        word: parsed.word,
        phonetic: parsed.phonetic,
        meaning: parsed.meaning,
        example: parsed.example,
        source: parsed.source || activeProject?.title || ''
      }
    })
    setTab('vocab')
    showToast('已从回答中提取词汇信息，请确认后保存')
  }

  async function deleteNote(note: Note): Promise<void> {
    if (!confirm(`删除笔记“${note.title}”？`)) return
    await window.margin.notes.remove(note.id)
    await refreshNotes()
    showToast('笔记已删除')
  }

  async function deleteVocab(item: Vocab): Promise<void> {
    if (!confirm(`删除生词“${item.word}”？`)) return
    await window.margin.vocab.remove(item.id)
    await refreshVocab()
    showToast('生词已删除')
  }

  async function createProject(title: string, author: string): Promise<void> {
    const project = await window.margin.app.createProject({ kind: 'literature', title, author })
    await switchProject(project.id)
    showToast('文献项目已创建')
  }

  async function deleteProject(projectId: string): Promise<void> {
    await window.margin.app.deleteProject(projectId)
    drafts.current.delete(projectId)
    const nextProject = activeIdRef.current === projectId ? 'english-reading' : activeIdRef.current
    const data = await window.margin.app.activateProject(nextProject)
    if (nextProject !== activeIdRef.current) {
      const draft = drafts.current.get(nextProject)
      updateComposer(draft?.text ?? '')
      updatePendingImage(draft?.image ?? null)
    }
    applyBootstrap(data)
    showToast('项目及其本地对话已删除')
  }

  async function updateSettings(patch: Partial<SettingsType>): Promise<void> {
    const next = await window.margin.app.updateSettings(patch)
    setSettings(next)
    settingsRef.current = next
  }

  async function exportData(): Promise<void> {
    const path = await window.margin.app.exportData()
    if (path) showToast(`已导出到 ${path}`)
  }

  async function refreshApiConfig(): Promise<void> {
    const providers = await window.margin.api.providers()
    setApiProviders(providers)
    const data = await window.margin.app.bootstrap()
    setConversation(data.conversation)
    conversationRef.current = data.conversation
    setStatus(data.apiStatus)
    setSettings(data.settings)
    settingsRef.current = data.settings
  }

  async function openInspector(): Promise<void> {
    try {
      await window.margin.chat.openInspector(activeIdRef.current)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function changeConversationApi(input: {
    providerId?: string
    model?: string
  }): Promise<void> {
    try {
      const projectId = activeIdRef.current
      const next = await window.margin.api.setConversation({ projectId, ...input })
      if (activeIdRef.current !== projectId) return
      if (next) {
        setConversation(next)
        conversationRef.current = next
      }
      setStatus(await window.margin.api.status())
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  function scheduleAutoHide(): void {
    if (!settingsRef.current?.autoHide || settingsRef.current.pinned) return
    if (
      railPanel ||
      settingsOpen ||
      noteDraft ||
      vocabDraft ||
      captureChoice ||
      noteView
    ) {
      return
    }
    const active = document.activeElement
    if (
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLInputElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    ) {
      return
    }
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      void window.margin.window.collapse()
    }, 720)
  }

  function cancelAutoHide(): void {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    },
    []
  )

  if (!booted || !settings) {
    return (
      <div className="loading-screen">
        <div className="loading-mark">M</div>
        <span>正在打开页边…</span>
      </div>
    )
  }

  if (windowState.collapsed) {
    const isTop = windowState.side === 'top'
    return (
      <div
        className={`rail ${windowState.side}`}
        onMouseEnter={() => void window.margin.window.expand(false)}
        onClick={() => void window.margin.window.expand(true)}
        title="展开页边"
      >
        <span className="rail-mark">M</span>
        {isTop ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>
    )
  }

  const currentStatusLabel = statusLabel(status)
  const currentStatusClass = statusClass(status)
  const shortcut = settings.selectionShortcut.replace('CommandOrControl', 'Ctrl')

  return (
    <div
      className={`app ${windowState.side}`}
      onMouseEnter={cancelAutoHide}
      onMouseLeave={scheduleAutoHide}
    >
      <WorkspaceRail
        panel={railPanel}
        onPanelChange={setRailPanel}
        pinned={settings.pinned}
        onPin={() => void window.margin.window.setPinned(!settings.pinned)}
        onSettings={() => setSettingsOpen(true)}
      />
      <div className="workspace-main">
        <header className="app-header">
          <div className="brand">
            <div className="brand-mark">M</div>
            <div className="brand-text">
              <strong>页边</strong>
              <span>Margin</span>
            </div>
          </div>
          <div className="header-actions">
            <button className="icon-button" title="收起" onClick={() => void window.margin.window.collapse()}>
              {windowState.side === 'top' ? <ChevronUp size={17} /> : <PanelRightClose size={17} />}
            </button>
          </div>
        </header>

        <div className="project-bar">
          <div className="current-project" title={activeProject?.title}>
            <BookOpen size={15} />
            <span>{activeProject?.title ?? '英语阅读'}</span>
          </div>
          <button
            className={`status-chip ${currentStatusClass}`}
            title={status.message}
            onClick={() => setSettingsOpen(true)}
          >
            <span className="status-dot" />
            {currentStatusLabel}
          </button>
          {apiProviders.length > 0 && (
            <select
              className="model-select"
              value={conversation ? JSON.stringify([conversation.providerId, conversation.model || activeProvider?.defaultModel || '']) : ''}
              onChange={(event) => {
                const [providerId, model] = JSON.parse(event.target.value) as [string, string]
                void changeConversationApi({ providerId, model })
              }}
              aria-label="选择提供商和模型"
              title={activeProvider ? `${activeProvider.name} · ${conversation?.model || '请选择模型'}` : '选择提供商和模型'}
            >
              {!conversation && <option value="" disabled>选择提供商和模型</option>}
              {apiProviders.map((provider) => {
                const currentModel = provider.id === conversation?.providerId ? conversation.model : ''
                const models = [...new Set([currentModel, provider.defaultModel, ...provider.models].filter(Boolean))]
                return (
                  <optgroup key={provider.id} label={provider.name + (provider.hasKey ? '' : '（未连接）')}>
                    {(models.length ? models : ['']).map((model) => (
                      <option key={model} value={JSON.stringify([provider.id, model])}>
                        {model || '未配置模型'}
                      </option>
                    ))}
                  </optgroup>
                )
              })}
            </select>
          )}
          <button
            className="icon-button small"
            title="查看本地真实会话与发送记录"
            onClick={() => void openInspector()}
          >
            <Eye size={14} />
          </button>
        </div>

        <nav className="tabs">
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => {
            setTab('chat')
            setRailPanel(null)
          }}>
            <MessageSquare size={15} />
            对话
          </button>
          <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
            <StickyNote size={15} />
            笔记
            {notes.length > 0 && <span className="tab-count">{notes.length}</span>}
          </button>
          <button className={tab === 'vocab' ? 'active' : ''} onClick={() => setTab('vocab')}>
            <Languages size={15} />
            生词
            {vocab.length > 0 && <span className="tab-count">{vocab.length}</span>}
          </button>
        </nav>

        <main className="app-main" onPointerDownCapture={(event) => {
          if (railPanel && event.target instanceof Element && !event.target.closest('.workspace-panel')) {
            setRailPanel(null)
          }
        }}>
          <WorkspacePanel
            panel={railPanel}
            onPanelChange={setRailPanel}
            projects={projects}
            activeProjectId={activeProjectId}
            onActivate={switchProject}
            onCreate={createProject}
            onDelete={requestDeleteProject}
            providers={apiProviders}
            activeProvider={activeProvider}
          />
          {tab === 'chat' && (
            <ChatView
              key={activeProjectId}
              messages={messages}
              messagesHasMore={messagesHasMore}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlderMessages}
              sending={sending}
              composer={composer}
              apiReady={status.phase === 'ready'}
              pendingImage={pendingImage}
              onRemoveImage={() => updatePendingImage(null)}
              onComposerChange={updateComposer}
              onSend={requestSend}
              canSearch={Boolean(activeProvider && supportsWebSearch(activeProvider))}
              onStop={() => void stopGeneration()}
              onCapture={() => void window.margin.capture.start()}
              onSelectionHelp={() => showToast(`在任意应用中选中文字后按 ${shortcut}`)}
              onSaveVocabAnswer={(answer, question) => saveVocabFromAnswer(answer, question)}
              onSaveAnswer={(content) =>
                setNoteDraft({
                  initial: {
                    title: '来自对话的笔记',
                    content,
                    source: conversation ? `${activeProvider?.name ?? 'API'} · ${conversation.model}` : '',
                    notebook: activeProject?.kind === 'english' ? '英语阅读' : '文献笔记'
                  }
                })
              }
            />
          )}
          {tab === 'notes' && (
            <NotesView
              notes={notes}
              folders={folders.filter((folder) => folder.kind === 'note')}
              noteTypes={noteTypes}
              projects={projects}
              selectedFolder={notesFolder}
              onSelectFolder={() => setFolderModal('note')}
              onManageTypes={() => setTypesOpen(true)}
              onNew={() =>
                setNoteDraft({
                  initial: {
                    notebook: noteTypes[0]?.name ?? '文献笔记',
                    noteTypeId: noteTypes[0]?.id ?? null,
                    folderId:
                      notesFolder !== 'all' && notesFolder !== 'uncategorized'
                        ? notesFolder
                        : null
                  }
                })
              }
              onOpen={(note) => setNoteView(note)}
              onEdit={(note) => setNoteDraft({ initial: note })}
              onMove={(note) => setMoveNote(note)}
              onDelete={(note) => void deleteNote(note)}
            />
          )}
          {tab === 'vocab' && (
            <VocabView
              vocab={vocab}
              folders={folders.filter((folder) => folder.kind === 'vocab')}
              projects={projects}
              selectedFolder={vocabFolder}
              onSelectFolder={() => setFolderModal('vocab')}
              onNew={() =>
                setVocabDraft({
                  initial: {
                    source: '手动添加',
                    folderId:
                      vocabFolder !== 'all' && vocabFolder !== 'uncategorized'
                        ? vocabFolder
                        : null
                  }
                })
              }
              onEdit={(item) => setVocabDraft({ initial: item })}
              onMove={(item) => setMoveVocab(item)}
              onReview={(item) => {
                void window.margin.vocab.review(item.id).then(() => refreshVocab())
              }}
              onDelete={(item) => void deleteVocab(item)}
            />
          )}
        </main>
      </div>

      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}

      {noteView && (
        <NoteDetailModal
          note={noteView}
          folders={folders.filter((folder) => folder.kind === 'note')}
          onClose={() => setNoteView(null)}
          onEdit={(note) => {
            setNoteView(null)
            setNoteDraft({ initial: note })
          }}
          onMove={(note) => {
            setNoteView(null)
            setMoveNote(note)
          }}
          onDelete={(note) => {
            setNoteView(null)
            void deleteNote(note)
          }}
        />
      )}
      {noteDraft && (
        <NoteEditorModal
          initial={noteDraft.initial}
          projectId={activeProjectId}
          folders={folders.filter((folder) => folder.kind === 'note')}
          noteTypes={noteTypes}
          onClose={() => setNoteDraft(null)}
          onSave={saveNote}
        />
      )}
      {vocabDraft && (
        <VocabEditorModal
          initial={vocabDraft.initial}
          projectId={activeProjectId}
          folders={folders.filter((folder) => folder.kind === 'vocab')}
          onClose={() => setVocabDraft(null)}
          onSave={saveVocab}
        />
      )}
      {folderModal && (
        <FolderTreeModal
          kind={folderModal}
          folders={folders.filter((folder) => folder.kind === folderModal)}
          items={folderModal === 'note' ? notes : vocab}
          selected={folderModal === 'note' ? notesFolder : vocabFolder}
          mode="browse"
          onSelect={(filter) =>
            folderModal === 'note' ? setNotesFolder(filter) : setVocabFolder(filter)
          }
          onCreate={(parentId, name) => createFolder(folderModal, parentId, name)}
          onRename={renameFolder}
          onDelete={removeFolder}
          onClose={() => setFolderModal(null)}
        />
      )}
      {moveNote && (
        <FolderTreeModal
          kind="note"
          folders={folders.filter((folder) => folder.kind === 'note')}
          items={notes}
          selected={moveNote.folderId ?? 'uncategorized'}
          mode="pick"
          onSelect={(filter) => {
            const note = moveNote
            setMoveNote(null)
            void moveNoteTo(note, filter)
          }}
          onCreate={(parentId, name) => createFolder('note', parentId, name)}
          onRename={renameFolder}
          onDelete={removeFolder}
          onClose={() => setMoveNote(null)}
        />
      )}
      {moveVocab && (
        <FolderTreeModal
          kind="vocab"
          folders={folders.filter((folder) => folder.kind === 'vocab')}
          items={vocab}
          selected={moveVocab.folderId ?? 'uncategorized'}
          mode="pick"
          onSelect={(filter) => {
            const item = moveVocab
            setMoveVocab(null)
            void moveVocabTo(item, filter)
          }}
          onCreate={(parentId, name) => createFolder('vocab', parentId, name)}
          onRename={renameFolder}
          onDelete={removeFolder}
          onClose={() => setMoveVocab(null)}
        />
      )}
      {typesOpen && (
        <NoteTypeManagerModal
          noteTypes={noteTypes}
          onSave={addNoteType}
          onRemove={removeNoteType}
          onClose={() => setTypesOpen(false)}
        />
      )}
      {deleteRequest && (
        <DeleteProjectModal
          project={deleteRequest.project}
          usage={deleteRequest.usage}
          onConfirm={async () => {
            const project = deleteRequest.project
            setDeleteRequest(null)
            await deleteProject(project.id)
          }}
          onClose={() => setDeleteRequest(null)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          providers={apiProviders}
          status={status}
          conversation={conversation}
          onChange={updateSettings}
          onRefresh={refreshApiConfig}
          onConversationChange={changeConversationApi}
          onExport={exportData}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {captureChoice && (
        <Modal
          title="截图已截取"
          subtitle="选择“摘抄”让模型逐字整理成笔记，或先上传到会话再自己提问。"
          onClose={() => setCaptureChoice(null)}
        >
          <div className="capture-choice-preview">
            <img src={captureChoice.dataUrl} alt="截取的区域" />
          </div>
          <div className="capture-choice-meta">
            {captureChoice.width} × {captureChoice.height}
          </div>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setCaptureChoice(null)}>
              取消
            </button>
            <button
              className="ghost-button"
              disabled={excerpting}
              onClick={() => {
                const image = captureChoice
                setCaptureChoice(null)
                updatePendingImage(image)
                setTab('chat')
                showToast('截图已附加，输入问题后发送。')
                window.setTimeout(
                  () => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),
                  80
                )
              }}
            >
              <Upload size={14} />
              上传到会话
            </button>
            <button
              className="primary-button"
              disabled={excerpting}
              onClick={() => {
                const image = captureChoice
                setCaptureChoice(null)
                void runExcerpt({ imageDataUrl: image.dataUrl })
              }}
            >
              {excerpting ? <Loader2 size={14} className="spin" /> : <NotebookPen size={14} />}
              摘抄
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
