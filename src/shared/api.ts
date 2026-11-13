import type {
  BootstrapData,
  CaptureResult,
  ConversationBinding,
  DeepSeekStatus,
  Folder,
  FolderKind,
  IpcResult,
  MessageCursor,
  MessagePage,
  ScreenStatusEvent,
  Note,
  NoteTypeDefinition,
  Project,
  ProjectKind,
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

export interface LastAssistantAnswer {
  text: string
  reasoning: string
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
  projectId: string
  text: string
  displayText?: string
  assistantId: string
  createIfMissing: boolean
  imageDataUrl?: string
}

export interface MarginApi {
  app: {
    bootstrap: () => Promise<BootstrapData>
    activateProject: (projectId: string) => Promise<BootstrapData>
    createProject: (input: CreateProjectInput) => Promise<Project>
    deleteProject: (projectId: string) => Promise<void>
    deleteProjectPreview: (projectId: string) => Promise<ProjectUsage>
    updateSettings: (patch: Partial<Settings>) => Promise<Settings>
    exportData: () => Promise<string | null>
    saveTextFile: (input: { fileName: string; content: string }) => Promise<string | null>
    copyText: (text: string) => Promise<void>
  }
  window: {
    getState: () => Promise<WindowState>
    collapse: () => Promise<void>
    expand: (focus?: boolean) => Promise<void>
    toggle: () => Promise<void>
    setPinned: (pinned: boolean) => Promise<Settings>
    setSide: (side: 'right' | 'top') => Promise<Settings>
    onStateChange: (callback: (state: WindowState) => void) => () => void
  }
  chat: {
    send: (input: SendMessageInput) => Promise<IpcResult<ConversationBinding | null>>
    stop: () => Promise<void>
    messages: (projectId: string, before?: MessageCursor) => Promise<MessagePage>
    onStream: (callback: (event: StreamEvent) => void) => () => void
    onScreenStatus: (callback: (event: ScreenStatusEvent) => void) => () => void
  }
  deepseek: {
    status: () => Promise<DeepSeekStatus>
    reconnect: (projectId?: string) => Promise<DeepSeekStatus>
    show: () => Promise<void>
    hide: () => Promise<void>
    bindCurrent: (projectId: string) => Promise<ConversationBinding>
    bindUrl: (projectId: string, url: string) => Promise<ConversationBinding>
    diagnose: () => Promise<Record<string, unknown>>
    readLast: () => Promise<LastAssistantAnswer>
    onStatusChange: (callback: (status: DeepSeekStatus) => void) => () => void
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
