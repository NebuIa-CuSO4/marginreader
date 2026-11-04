export type ProjectKind = 'literature' | 'english'

export interface Project {
  id: string
  kind: ProjectKind
  title: string
  author: string
  createdAt: number
}

export type BindingStatus =
  | 'unbound'
  | 'connected'
  | 'login_required'
  | 'missing'
  | 'mismatch'
  | 'not_loaded'

export interface ConversationBinding {
  projectId: string
  provider: 'deepseek-web'
  externalId: string | null
  url: string | null
  status: BindingStatus
  updatedAt: number
}

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'sending' | 'streaming' | 'complete' | 'interrupted' | 'error'

export interface MessageCursor {
  createdAt: number
  id: string
}

export interface MessagePage {
  messages: ChatMessage[]
  hasMore: boolean
  oldest: MessageCursor | null
}

export interface ChatMessage {
  id: string
  projectId: string
  role: MessageRole
  content: string
  reasoning?: string
  status: MessageStatus
  createdAt: number
}

export type NoteType = 'note' | 'vocab'
export type FolderKind = 'note' | 'vocab'

export interface Folder {
  id: string
  kind: FolderKind
  parentId: string | null
  name: string
  color: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface NoteTypeDefinition {
  id: string
  name: string
  color: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface Note {
  id: string
  projectId: string
  folderId: string | null
  noteTypeId: string | null
  notebook: string
  type: NoteType
  title: string
  content: string
  tags: string[]
  source: string
  createdAt: number
  updatedAt: number
}

export interface Vocab {
  id: string
  projectId: string
  folderId: string | null
  word: string
  phonetic: string
  meaning: string
  example: string
  source: string
  createdAt: number
  updatedAt: number
  reviewCount: number
  lastReviewedAt: number | null
}

export type DockSide = 'right' | 'top'
export type ThemeMode = 'light' | 'dark' | 'sepia'

export interface Settings {
  dockSide: DockSide
  theme: ThemeMode
  pinned: boolean
  autoHide: boolean
  ocrLanguage: 'auto' | 'en-US' | 'zh-Hans-CN'
  toggleShortcut: string
  screenshotShortcut: string
  selectionShortcut: string
  autoSendSelection: boolean
  autoScreenContext: boolean
  launchAtLogin: boolean
  activeProjectId: string
  onboardingDone: boolean
}

export interface DeepSeekStatus {
  phase: 'not_started' | 'loading' | 'login_required' | 'ready' | 'error'
  url: string
  externalId: string | null
  loginRequired: boolean
  composerReady: boolean
  pageTitle: string
  message: string
}

export interface WindowState {
  collapsed: boolean
  side: DockSide
  pinned: boolean
}

export interface BootstrapData {
  projects: Project[]
  activeProjectId: string
  binding: ConversationBinding | null
  messages: ChatMessage[]
  messagesHasMore: boolean
  notes: Note[]
  vocab: Vocab[]
  folders: Folder[]
  noteTypes: NoteTypeDefinition[]
  settings: Settings
  windowState: WindowState
  deepseek: DeepSeekStatus
}

export interface CaptureResult {
  text: string
  imageDataUrl?: string
  lineCount: number
  width: number
  height: number
  error?: string
}

export type SelectionActionKind = 'translate' | 'explain' | 'save'

export interface SelectionAction {
  action: SelectionActionKind
  text: string
}

export interface StreamEvent {
  projectId: string
  assistantId: string
  phase: 'start' | 'delta' | 'done' | 'error' | 'stopped'
  text?: string
  reasoning?: string
  error?: string
}

export interface ScreenStatusEvent {
  projectId: string
  imageAttached: boolean
  usedFallbackText: boolean
}

export interface IpcResult<T> {
  ok: boolean
  data?: T
  error?: string
  code?: string
}
