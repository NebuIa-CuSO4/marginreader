import { contextBridge, ipcRenderer } from 'electron'
import type {
  ApiTestResult,
  ExcerptInput,
  ExcerptResult,
  FolderDeleteResult,
  MarginApi,
  ProjectUsage
} from '../shared/api'
import type {
  ApiConversation,
  ApiProvider,
  ApiStatus,
  BootstrapData,
  CaptureResult,
  ConversationInspection,
  Folder,
  FolderKind,
  IpcResult,
  MessagePage,
  Note,
  NoteTypeDefinition,
  Project,
  SelectionAction,
  Settings,
  StreamEvent,
  Vocab,
  WindowState
} from '../shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: MarginApi = {
  history: {
    preview: (input) => ipcRenderer.invoke('history:preview', input),
    remove: (input) => ipcRenderer.invoke('history:remove', input)
  },
  app: {
    reportRendererError: (area, name) => ipcRenderer.send('app:renderer-error', area, name),
    bootstrap: () => ipcRenderer.invoke('app:bootstrap') as Promise<BootstrapData>,
    activateProject: (projectId) =>
      ipcRenderer.invoke('app:activate-project', projectId) as Promise<BootstrapData>,
    createProject: (input) => ipcRenderer.invoke('app:create-project', input) as Promise<Project>,
    deleteProject: (projectId) => ipcRenderer.invoke('app:delete-project', projectId) as Promise<void>,
    deleteProjectPreview: (projectId) =>
      ipcRenderer.invoke('app:delete-project-preview', projectId) as Promise<ProjectUsage>,
    updateSettings: (patch) =>
      ipcRenderer.invoke('app:update-settings', patch) as Promise<Settings>,
    exportData: () => ipcRenderer.invoke('app:export-data') as Promise<string | null>,
    saveTextFile: (input) =>
      ipcRenderer.invoke('app:save-text-file', input) as Promise<string | null>,
    copyText: (text) => ipcRenderer.invoke('app:copy-text', text) as Promise<void>
  },
  todos: {
    list: () => ipcRenderer.invoke('todos:list'),
    add: (title) => ipcRenderer.invoke('todos:add', title),
    update: (id, patch) => ipcRenderer.invoke('todos:update', id, patch),
    remove: (id) => ipcRenderer.invoke('todos:remove', id)
  },
  quota: {
    deepSeek: (id) => ipcRenderer.invoke('quota:deepseek', id),
    codex: () => ipcRenderer.invoke('quota:codex')
  },
  excerpt: {
    run: (input: ExcerptInput) =>
      ipcRenderer.invoke('excerpt:run', input) as Promise<ExcerptResult>
  },
  window: {
    getState: () => ipcRenderer.invoke('window:get-state') as Promise<WindowState>,
    collapse: () => ipcRenderer.invoke('window:collapse') as Promise<void>,
    expand: (focus = false) => ipcRenderer.invoke('window:expand', focus) as Promise<void>,
    toggle: () => ipcRenderer.invoke('window:toggle') as Promise<void>,
    setPinned: (pinned) => ipcRenderer.invoke('window:set-pinned', pinned) as Promise<Settings>,
    setSide: (side) => ipcRenderer.invoke('window:set-side', side) as Promise<Settings>,
    closeCurrent: () => ipcRenderer.invoke('window:close-current') as Promise<void>,
    onStateChange: (callback) => subscribe<WindowState>('window:state-changed', callback)
  },
  chat: {
    send: (input) =>
      ipcRenderer.invoke('chat:send', input) as Promise<IpcResult<ApiConversation | null>>,
    stop: (projectId, assistantId) => ipcRenderer.invoke('chat:stop', projectId, assistantId) as Promise<void>,
    messages: (projectId, before) =>
      ipcRenderer.invoke('chat:messages', projectId, before) as Promise<MessagePage>,
    inspect: (projectId) =>
      ipcRenderer.invoke('chat:inspect', projectId) as Promise<ConversationInspection>,
    openInspector: (projectId) =>
      ipcRenderer.invoke('chat:open-inspector', projectId) as Promise<void>,
    readRequestLogImage: (requestId, fileName) =>
      ipcRenderer.invoke('chat:request-log-image', requestId, fileName) as Promise<string | null>,
    onStream: (callback) => subscribe<StreamEvent>('chat:stream', callback)
  },
  api: {
    connectChatGPT: () => ipcRenderer.invoke('api:connect-chatgpt') as Promise<ApiProvider>,
    disconnectChatGPT: () => ipcRenderer.invoke('api:disconnect-chatgpt') as Promise<void>,
    providers: () => ipcRenderer.invoke('api:providers') as Promise<ApiProvider[]>,
    saveProvider: (input) =>
      ipcRenderer.invoke('api:save-provider', input) as Promise<ApiProvider>,
    deleteProvider: (id) => ipcRenderer.invoke('api:delete-provider', id) as Promise<void>,
    saveKey: (providerId, key) =>
      ipcRenderer.invoke('api:save-key', providerId, key) as Promise<void>,
    clearKey: (providerId) => ipcRenderer.invoke('api:clear-key', providerId) as Promise<void>,
    test: (providerId, options) =>
      ipcRenderer.invoke('api:test', providerId, options) as Promise<ApiTestResult>,
    refreshModels: (id) => ipcRenderer.invoke('api:refresh-models', id) as Promise<ApiProvider>,
    testSearch: (id, model) => ipcRenderer.invoke('api:test-search', id, model) as Promise<ApiTestResult>,
    status: () => ipcRenderer.invoke('api:status') as Promise<ApiStatus>,
    setConversation: (input) =>
      ipcRenderer.invoke('api:set-conversation', input) as Promise<ApiConversation | null>,
    onStatusChange: (callback) => subscribe<ApiStatus>('api:status-changed', callback)
  },
  capture: {
    start: () => ipcRenderer.invoke('capture:start') as Promise<void>,
    onResult: (callback) => subscribe<CaptureResult>('capture:result', callback)
  },
  folders: {
    list: (kind?: FolderKind) => ipcRenderer.invoke('folders:list', kind) as Promise<Folder[]>,
    create: (input) => ipcRenderer.invoke('folders:create', input) as Promise<Folder>,
    rename: (id, name) => ipcRenderer.invoke('folders:rename', id, name) as Promise<void>,
    move: (id, parentId) => ipcRenderer.invoke('folders:move', id, parentId) as Promise<void>,
    remove: (id) => ipcRenderer.invoke('folders:remove', id) as Promise<FolderDeleteResult>
  },
  noteTypes: {
    list: () => ipcRenderer.invoke('note-types:list') as Promise<NoteTypeDefinition[]>,
    save: (input) => ipcRenderer.invoke('note-types:save', input) as Promise<NoteTypeDefinition>,
    remove: (id) => ipcRenderer.invoke('note-types:remove', id) as Promise<void>
  },
  notes: {
    list: (projectId, query = '') =>
      ipcRenderer.invoke('notes:list', projectId, query) as Promise<Note[]>,
    save: (note) => ipcRenderer.invoke('notes:save', note) as Promise<Note>,
    remove: (id) => ipcRenderer.invoke('notes:remove', id) as Promise<void>
  },
  vocab: {
    list: (projectId, query = '') =>
      ipcRenderer.invoke('vocab:list', projectId, query) as Promise<Vocab[]>,
    save: (item) => ipcRenderer.invoke('vocab:save', item) as Promise<Vocab>,
    review: (id) => ipcRenderer.invoke('vocab:review', id) as Promise<void>,
    remove: (id) => ipcRenderer.invoke('vocab:remove', id) as Promise<void>
  },
  selection: {
    onAction: (callback) => subscribe<SelectionAction>('selection:action', callback)
  }
}

contextBridge.exposeInMainWorld('margin', api)
