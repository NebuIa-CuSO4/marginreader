import type {
  ApiConversation,
  ApiProvider,
  ApiStatus,
  BootstrapData,
  CaptureResult,
  ConversationInspection,
  CodexQuota,
  DeepSeekQuota,
  DeepSeekUsageReport,
  TodoItem,
  Folder,
  FolderKind,
  IpcResult,
  MessageCursor,
  MessagePage,
  Note,
  NoteTypeDefinition,
  Project,
  ProjectKind,
  SearchStatus,
  SelectionAction,
  Settings,
  StreamEvent,
  Vocab,
  WindowState
} from './types'

export interface CreateProjectInput {
  kind: ProjectKind
  title: string
  author?: string
}

export interface ProjectUsage {
  notes: number
  vocab: number
  messages: number
}

export interface FolderDeleteResult {
  notes: number
  vocab: number
  folders: number
}

export interface SendMessageInput {
  webSearch?: boolean
  projectId: string
  text: string
  displayText?: string
  assistantId: string
  userId?: string
  imageDataUrl?: string
}

export interface ExcerptInput {
  projectId: string
  text?: string
  imageDataUrl?: string
}

export interface ExcerptResult {
  note: Note
  exact: boolean | null
}

export interface ApiTestResult {
  ok: boolean
  message: string
  models?: string[]
  supportsVision?: boolean
  searchStatus?: SearchStatus
}

export interface HistoryFilter {
  projectId: string
  before: number
  messages: boolean
  logs: boolean
  images: boolean
}

export interface HistoryPreview {
  messages: number
  logs: number
  images: number
  fileBytes: number
}

export interface MarginApi {
  history: {
    preview: (input: HistoryFilter) => Promise<HistoryPreview>
    remove: (input: HistoryFilter) => Promise<HistoryPreview>
  }
  app: {
    bootstrap: () => Promise<BootstrapData>
    reportRendererError: (area: 'app' | 'markdown', name: string) => void
    activateProject: (projectId: string) => Promise<BootstrapData>
    createProject: (input: CreateProjectInput) => Promise<Project>
    deleteProject: (projectId: string) => Promise<void>
    deleteProjectPreview: (projectId: string) => Promise<ProjectUsage>
    updateSettings: (patch: Partial<Settings>) => Promise<Settings>
    exportData: () => Promise<string | null>
    saveTextFile: (input: { fileName: string; content: string }) => Promise<string | null>
    copyText: (text: string) => Promise<void>
  }
  todos: {
    list: () => Promise<TodoItem[]>
    add: (title: string) => Promise<TodoItem>
    update: (id: string, patch: { title?: string; completed?: boolean }) => Promise<TodoItem>
    remove: (id: string) => Promise<void>
  }
  quota: {
    deepSeek: (providerId: string) => Promise<DeepSeekQuota>
    deepSeekUsage: (providerId: string) => Promise<DeepSeekUsageReport | null>
    importDeepSeekUsage: (providerId: string) => Promise<IpcResult<DeepSeekUsageReport | null>>
    codex: () => Promise<IpcResult<CodexQuota>>
  }
  excerpt: {
    run: (input: ExcerptInput) => Promise<ExcerptResult>
  }
  window: {
    getState: () => Promise<WindowState>
    collapse: () => Promise<void>
    expand: (focus?: boolean) => Promise<void>
    toggle: () => Promise<void>
    setPinned: (pinned: boolean) => Promise<Settings>
    setSide: (side: 'right' | 'top') => Promise<Settings>
    closeCurrent: () => Promise<void>
    onStateChange: (callback: (state: WindowState) => void) => () => void
  }
  chat: {
    send: (input: SendMessageInput) => Promise<IpcResult<ApiConversation | null>>
    stop: (projectId: string, assistantId: string) => Promise<void>
    messages: (projectId: string, before?: MessageCursor) => Promise<MessagePage>
    inspect: (projectId: string) => Promise<ConversationInspection>
    openInspector: (projectId: string) => Promise<void>
    readRequestLogImage: (requestId: string, fileName: string) => Promise<string | null>
    onStream: (callback: (event: StreamEvent) => void) => () => void
  }
  api: {
    connectChatGPT: () => Promise<ApiProvider>
    disconnectChatGPT: () => Promise<void>
    providers: () => Promise<ApiProvider[]>
    saveProvider: (input: Partial<ApiProvider> & { id: string; name: string; baseUrl: string }) => Promise<ApiProvider>
    deleteProvider: (id: string) => Promise<void>
    saveKey: (providerId: string, key: string) => Promise<void>
    clearKey: (providerId: string) => Promise<void>
    test: (providerId: string, options?: { model?: string; probeImages?: boolean }) => Promise<ApiTestResult>
    refreshModels: (providerId: string) => Promise<ApiProvider>
    testSearch: (providerId: string, model: string) => Promise<ApiTestResult>
    status: () => Promise<ApiStatus>
    setConversation: (input: {
      projectId: string
      providerId?: string
      model?: string
    }) => Promise<ApiConversation | null>
    onStatusChange: (callback: (status: ApiStatus) => void) => () => void
  }
  capture: {
    start: () => Promise<void>
    onResult: (callback: (result: CaptureResult) => void) => () => void
  }
  folders: {
    list: (kind?: FolderKind) => Promise<Folder[]>
    create: (input: {
      kind: FolderKind
      parentId?: string | null
      name: string
      color?: string
    }) => Promise<Folder>
    rename: (id: string, name: string) => Promise<void>
    move: (id: string, parentId: string | null) => Promise<void>
    remove: (id: string) => Promise<FolderDeleteResult>
  }
  noteTypes: {
    list: () => Promise<NoteTypeDefinition[]>
    save: (input: { id?: string; name: string; color?: string }) => Promise<NoteTypeDefinition>
    remove: (id: string) => Promise<void>
  }
  notes: {
    list: (projectId: string, query?: string) => Promise<Note[]>
    save: (note: Partial<Note> & { projectId: string; title: string }) => Promise<Note>
    remove: (id: string) => Promise<void>
  }
  vocab: {
    list: (projectId: string, query?: string) => Promise<Vocab[]>
    save: (item: Partial<Vocab> & { projectId: string; word: string }) => Promise<Vocab>
    review: (id: string) => Promise<void>
    remove: (id: string) => Promise<void>
  }
  selection: {
    onAction: (callback: (action: SelectionAction) => void) => () => void
  }
}
