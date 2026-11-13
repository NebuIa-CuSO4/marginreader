import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Languages,
  MessageSquare,
  PanelRightClose,
  Pin,
  PinOff,
  RefreshCw,
  Settings,
  StickyNote
} from 'lucide-react'
import type {
  BootstrapData,
  ChatMessage,
  ConversationBinding,
  DeepSeekStatus,
  Folder,
  Note,
  NoteTypeDefinition,
  Project,
  ScreenStatusEvent,
  SelectionAction,
  Settings as SettingsType,
  StreamEvent,
  Vocab,
  WindowState
} from '../../shared/types'
import { ChatView } from './components/ChatView'
import { NotesView } from './components/NotesView'
import { VocabView } from './components/VocabView'
import { ProjectsModal } from './components/ProjectsModal'
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

const EMPTY_STATUS: DeepSeekStatus = {
  phase: 'not_started',
  url: '',
  externalId: null,
  loginRequired: false,
  composerReady: false,
  pageTitle: '',
  message: '尚未连接 DeepSeek 网页'
}

type Tab = 'chat' | 'notes' | 'vocab'

interface PendingImage {
  dataUrl: string
  width: number
  height: number
}

function statusLabel(status: DeepSeekStatus, binding: ConversationBinding | null): string {
  if (status.phase === 'loading') return '连接中'
  if (status.phase === 'offline') return '网络未连接'
  if (status.phase === 'login_required') return '需登录'
  if (status.phase === 'error') return '连接异常'
  if (status.phase === 'ready') return binding?.status === 'connected' ? '已连接' : '未绑定对话'
  return '未连接'
}

function statusClass(status: DeepSeekStatus, binding: ConversationBinding | null): string {
  if (status.phase === 'ready' && binding?.status === 'connected') return 'connected'
  if (status.phase === 'offline' || status.phase === 'login_required') return 'warning'
  if (status.phase === 'error') return 'error'
  if (status.phase === 'loading') return 'loading'
  return 'idle'
}

export default function App(): React.JSX.Element {
  const [booted, setBooted] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState('english-reading')
  const [binding, setBinding] = useState<ConversationBinding | null>(null)
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
  const [status, setStatus] = useState<DeepSeekStatus>(EMPTY_STATUS)
  const [reconnecting, setReconnecting] = useState(false)
  const [readIssue, setReadIssue] = useState(false)
  const [windowState, setWindowState] = useState<WindowState>({
    collapsed: false,
    side: 'right',
    pinned: false
  })
  const [tab, setTab] = useState<Tab>('chat')
  const [composer, setComposer] = useState('')
  const [sending, setSending] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' } | null>(null)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [noteDraft, setNoteDraft] = useState<{ initial?: Partial<Note> } | null>(null)
  const [noteView, setNoteView] = useState<Note | null>(null)
  const [vocabDraft, setVocabDraft] = useState<{ initial?: Partial<Vocab> } | null>(null)
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null)
  const [confirmCreate, setConfirmCreate] = useState<{ text: string; imageDataUrl?: string } | null>(
    null
  )

  const activeIdRef = useRef(activeProjectId)
  const bindingRef = useRef<ConversationBinding | null>(null)
  const settingsRef = useRef<SettingsType | null>(null)
  const sendingRef = useRef(false)
  const composerRef = useRef('')
  const toastTimer = useRef<number | null>(null)
  const hideTimer = useRef<number | null>(null)
  const screenFallbackNotified = useRef(false)
  const pendingImageRef = useRef<PendingImage | null>(null)

  useEffect(() => {
    activeIdRef.current = activeProjectId
  }, [activeProjectId])
  useEffect(() => {
    bindingRef.current = binding
  }, [binding])
  useEffect(() => {
    settingsRef.current = settings
    if (settings) {
      document.documentElement.dataset.theme = settings.theme
    }
  }, [settings])
  useEffect(() => {
    sendingRef.current = sending
  }, [sending])
  useEffect(() => {
    composerRef.current = composer
  }, [composer])
  useEffect(() => {
    pendingImageRef.current = pendingImage
  }, [pendingImage])

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId),
    [projects, activeProjectId]
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
    setBinding(data.binding)
    bindingRef.current = data.binding
    setMessages(data.messages)
    setMessagesHasMore(data.messagesHasMore)
    setLoadingOlder(false)
    setNotes(data.notes)
    setVocab(data.vocab)
    setFolders(data.folders)
    setNoteTypes(data.noteTypes)
    setSettings(data.settings)
    settingsRef.current = data.settings
    setStatus(data.deepseek)
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
      if (event.phase === 'delta') {
        setSending(true)
        sendingRef.current = true
        setReadIssue(false)
      }
      if (event.phase === 'done' || event.phase === 'stopped') {
        setSending(false)
        sendingRef.current = false
        setReadIssue(false)
      }
      if (event.phase === 'error') {
        setSending(false)
        sendingRef.current = false
        setReadIssue(Boolean(event.error && /读取|回答/.test(event.error)))
      }
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
        setPendingImage({
          dataUrl: result.imageDataUrl,
          width: result.width,
          height: result.height
        })
        pendingImageRef.current = {
          dataUrl: result.imageDataUrl,
          width: result.width,
          height: result.height
        }
        setTab('chat')
        showToast('截图已附加，输入问题后发送。')
        window.setTimeout(
          () => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),
          80
        )
        return
      }
      if (result.text.trim()) {
        setTab('chat')
        setComposer(`屏幕内容：\n${result.text}\n\n我的问题：`)
        showToast('已读取屏幕文字')
        window.setTimeout(
          () => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),
          80
        )
        return
      }
      showToast('截图区域太小，可以换一个区域再试。', 'error')
    })

    const offStatus = window.margin.deepseek.onStatusChange((next) => setStatus(next))

    const offScreen = window.margin.chat.onScreenStatus((event: ScreenStatusEvent) => {
      if (event.projectId !== activeIdRef.current) return
      if (event.imageAttached) {
        screenFallbackNotified.current = false
      } else if (event.usedFallbackText && !screenFallbackNotified.current) {
        screenFallbackNotified.current = true
        showToast('网页没有接受原图，这次已改用文字发送（有 OCR 时会附带屏幕文字）。', 'error')
      }
    })

    const offSelection = window.margin.selection.onAction((action) => {
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
      setComposer(sendText)
      void window.margin.window.expand(true)
      const currentSettings = settingsRef.current
      if (currentSettings?.autoSendSelection && bindingRef.current?.status === 'connected') {
        window.setTimeout(() => void performSend(sendText, false, action.text), 120)
      }
    })

    return () => {
      offStream()
      offState()
      offCapture()
      offStatus()
      offScreen()
      offSelection()
    }
  }, [])

  async function switchProject(projectId: string): Promise<void> {
    const data = await window.margin.app.activateProject(projectId)
    applyBootstrap(data)
    setComposer('')
    setPendingImage(null)
    pendingImageRef.current = null
    setTab('chat')
    setProjectsOpen(false)
    screenFallbackNotified.current = false
  }

  async function performSend(
    text: string,
    createIfMissing: boolean,
    displayText?: string,
    imageDataUrl?: string
  ): Promise<void> {
    const clean = text.trim() || (imageDataUrl ? '请看这张截图。' : '')
    if (!clean || sendingRef.current) return
    if (!bindingRef.current && !createIfMissing) {
      setConfirmCreate({ text: clean, imageDataUrl })
      return
    }
    const assistantId = crypto.randomUUID()
    const userId = crypto.randomUUID()
    const timestamp = Date.now()
    const shownText = displayText?.trim() || clean
    setMessages((previous) => [
      ...previous,
      {
        id: userId,
        projectId: activeIdRef.current,
        role: 'user',
        content: shownText,
        status: 'sending',
        createdAt: timestamp
      },
      {
        id: assistantId,
        projectId: activeIdRef.current,
        role: 'assistant',
        content: '',
        reasoning: '',
        status: 'streaming',
        createdAt: timestamp + 1
      }
    ])
    setComposer('')
    setSending(true)
    sendingRef.current = true
    setReadIssue(false)
    setTab('chat')
    try {
      const result = await window.margin.chat.send({
        projectId: activeIdRef.current,
        text: clean,
        displayText: shownText,
        assistantId,
        createIfMissing,
        imageDataUrl
      })
      if (!result.ok) {
        const neverSent = new Set([
          'NETWORK_OFFLINE',
          'COMPOSER_NOT_FOUND',
          'LOGIN_REQUIRED',
          'URL_MISMATCH',
          'NO_BINDING',
          'BINDING_INVALID',
          'INVALID_URL'
        ])
        if (result.code && neverSent.has(result.code)) {
          setMessages((previous) =>
            previous.filter((message) => message.id !== userId && message.id !== assistantId)
          )
          setComposer((current) => current || text)
          if (result.code === 'NETWORK_OFFLINE') {
            setStatus((previous) => ({
              ...previous,
              phase: 'offline',
              composerReady: false,
              message: '网络未连接，请检查网络后点击“重连”。'
            }))
          }
        } else {
          setMessages((previous) =>
            previous.map((message) => {
              if (message.id === userId) return { ...message, status: 'error' }
              if (message.id === assistantId) {
                return { ...message, status: 'error', content: result.error ?? '发送失败' }
              }
              return message
            })
          )
        }
        setSending(false)
        sendingRef.current = false
        showToast(result.error ?? '发送失败', 'error')
        return
      }
      setMessages((previous) =>
        previous.map((message) =>
          message.id === userId ? { ...message, status: 'complete' } : message
        )
      )
      if (imageDataUrl) {
        setPendingImage(null)
        pendingImageRef.current = null
      }
      if (result.data) {
        setBinding(result.data)
        bindingRef.current = result.data
        if (result.data.status === 'unbound') {
          showToast('消息已发出，但未能捕获对话 ID。请打开网页并绑定当前对话。', 'error')
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMessages((previous) =>
        previous.map((item) => {
          if (item.id === userId) return { ...item, status: 'error' }
          if (item.id === assistantId) return { ...item, status: 'error', content: message }
          return item
        })
      )
      setSending(false)
      sendingRef.current = false
      showToast(message, 'error')
    }
  }

  function requestSend(): void {
    const text = composerRef.current.trim()
    const imageDataUrl = pendingImageRef.current?.dataUrl
    if (!text && !imageDataUrl) return
    const sendText = text || '请看这张截图。'
    if (!bindingRef.current) {
      setConfirmCreate({ text: sendText, imageDataUrl })
      return
    }
    void performSend(sendText, false, undefined, imageDataUrl)
  }

  async function stopGeneration(): Promise<void> {
    await window.margin.chat.stop()
    showToast('已请求停止')
    window.setTimeout(() => {
      if (sendingRef.current) {
        setSending(false)
        sendingRef.current = false
      }
    }, 1800)
  }

  async function recoverLastAnswer(assistantId: string): Promise<void> {
    try {
      const result = await window.margin.deepseek.readLast()
      if (!result.text.trim()) {
        showToast('网页里还没有可读取的回答。请打开网页面板确认。', 'error')
        return
      }
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: result.text,
                reasoning: result.reasoning || message.reasoning,
                status: 'complete'
              }
            : message
        )
      )
      setReadIssue(false)
      showToast('已从网页读取最后一条回答')
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
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

  async function reconnectDeepSeek(): Promise<void> {
    if (reconnecting) return
    setReconnecting(true)
    try {
      const next = await window.margin.deepseek.reconnect(activeIdRef.current)
      setStatus(next)
      if (next.phase === 'ready') {
        showToast('DeepSeek 已重新连接')
      } else if (next.phase === 'offline') {
        showToast('网络仍未连接，请检查网络', 'error')
      } else {
        showToast(next.message || '重新连接失败', 'error')
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setReconnecting(false)
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
    setProjectsOpen(false)
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
    const data = await window.margin.app.activateProject(project.id)
    applyBootstrap(data)
    setProjectsOpen(false)
    showToast('文献项目已创建')
  }

  async function deleteProject(projectId: string): Promise<void> {
    await window.margin.app.deleteProject(projectId)
    const data = await window.margin.app.activateProject('english-reading')
    applyBootstrap(data)
    showToast('项目已删除，网页对话未受影响')
  }

  async function bindCurrent(): Promise<void> {
    const result = await window.margin.deepseek.bindCurrent(activeIdRef.current)
    setBinding(result)
    bindingRef.current = result
    showToast('已绑定当前网页对话')
  }

  async function bindUrl(url: string): Promise<void> {
    const result = await window.margin.deepseek.bindUrl(activeIdRef.current, url)
    setBinding(result)
    bindingRef.current = result
    showToast('已绑定对话链接')
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

  function scheduleAutoHide(): void {
    if (!settingsRef.current?.autoHide || settingsRef.current.pinned) return
    if (projectsOpen || settingsOpen || noteDraft || vocabDraft || confirmCreate) return
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

  const currentStatusLabel = readIssue ? '读取异常' : statusLabel(status, binding)
  const currentStatusClass = readIssue ? 'error' : statusClass(status, binding)
  const shortcut = settings.selectionShortcut.replace('CommandOrControl', 'Ctrl')

  return (
    <div
      className={`app ${windowState.side}`}
      onMouseEnter={cancelAutoHide}
      onMouseLeave={scheduleAutoHide}
    >
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div className="brand-text">
            <strong>页边</strong>
            <span>Margin</span>
          </div>
        </div>
        <div className="header-actions">
          <button
            className={`icon-button ${settings.pinned ? 'active' : ''}`}
            title={settings.pinned ? '取消固定' : '固定展开'}
            onClick={() => void window.margin.window.setPinned(!settings.pinned)}
          >
            {settings.pinned ? <PinOff size={16} /> : <Pin size={16} />}
          </button>
          <button className="icon-button" title="设置" onClick={() => setSettingsOpen(true)}>
            <Settings size={16} />
          </button>
          <button className="icon-button" title="收起" onClick={() => void window.margin.window.collapse()}>
            {windowState.side === 'top' ? <ChevronUp size={17} /> : <PanelRightClose size={17} />}
          </button>
        </div>
      </header>

      <div className="project-bar">
        <button className="project-select" onClick={() => setProjectsOpen(true)}>
          <BookOpen size={15} />
          <span>{activeProject?.title ?? '英语阅读'}</span>
          <ChevronDown size={13} />
        </button>
        <button
          className={`status-chip ${currentStatusClass}`}
          title={readIssue ? '网页已连接，但回答读取失败。可以打开设置里的“诊断”，或打开网页面板确认。' : status.message}
          onClick={() => {
            if (readIssue) setSettingsOpen(true)
            else if (status.phase === 'ready') setProjectsOpen(true)
            else void window.margin.deepseek.show()
          }}
        >
          <span className="status-dot" />
          {currentStatusLabel}
        </button>
        {(status.phase === 'offline' || status.phase === 'error' || readIssue) && (
          <button
            className="reconnect-button"
            title="重新连接 DeepSeek"
            disabled={reconnecting}
            onClick={() => void reconnectDeepSeek()}
          >
            <RefreshCw size={13} className={reconnecting ? 'spin' : ''} />
            {reconnecting ? '重连中' : '重连'}
          </button>
        )}
        <button className="icon-button small" title="打开 DeepSeek 网页" onClick={() => void window.margin.deepseek.show()}>
          <ExternalLink size={14} />
        </button>
      </div>

      <nav className="tabs">
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
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

      <main className="app-main">
        {tab === 'chat' && (
          <ChatView
            key={activeProjectId}
            messages={messages}
            messagesHasMore={messagesHasMore}
            loadingOlder={loadingOlder}
            onLoadOlder={loadOlderMessages}
            sending={sending}
            composer={composer}
            hasBinding={Boolean(binding?.externalId)}
            pendingImage={pendingImage}
            onRemoveImage={() => {
              setPendingImage(null)
              pendingImageRef.current = null
            }}
            onComposerChange={setComposer}
            onSend={requestSend}
            onStop={() => void stopGeneration()}
            onCapture={() => void window.margin.capture.start()}
            onSelectionHelp={() => showToast(`在任意应用中选中文字后按 ${shortcut}`)}
            onRecoverAnswer={(assistantId) => void recoverLastAnswer(assistantId)}
            onOpenWeb={() => void window.margin.deepseek.show()}
            onSaveVocabAnswer={(answer, question) => saveVocabFromAnswer(answer, question)}
            onSaveAnswer={(content) =>
              setNoteDraft({
                initial: {
                  title: '来自对话的笔记',
                  content,
                  source: binding?.url ?? '',
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
      {projectsOpen && (
        <ProjectsModal
          projects={projects}
          activeProjectId={activeProjectId}
          binding={binding}
          status={status}
          onActivate={switchProject}
          onCreate={createProject}
          onDelete={requestDeleteProject}
          onBindCurrent={bindCurrent}
          onBindUrl={bindUrl}
          onOpenWeb={() => void window.margin.deepseek.show()}
          onClose={() => setProjectsOpen(false)}
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
          status={status}
          onChange={updateSettings}
          onOpenWeb={() => void window.margin.deepseek.show()}
          onHideWeb={() => void window.margin.deepseek.hide()}
          onExport={exportData}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {confirmCreate && (
        <Modal
          title="创建这个项目的网页对话？"
          subtitle="之后这个项目会一直复用同一条 DeepSeek 网页对话。"
          onClose={() => setConfirmCreate(null)}
        >
          <p className="confirm-copy">
            {activeProject?.kind === 'english'
              ? '英语阅读的所有文章会共用这条对话。'
              : `《${activeProject?.title ?? '当前项目'}》将绑定一条新的 DeepSeek 网页对话。`}
          </p>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setConfirmCreate(null)}>
              取消
            </button>
            <button
              className="primary-button"
              onClick={() => {
                const text = confirmCreate.text
                const imageDataUrl = confirmCreate.imageDataUrl
                setConfirmCreate(null)
                void performSend(text, true, undefined, imageDataUrl)
              }}
            >
              创建并发送
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
