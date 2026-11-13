import { contextBridge, ipcRenderer } from 'electron'
import type {
  FolderDeleteResult,
  LastAssistantAnswer,
  MarginApi,
  ProjectUsage
} from '../shared/api'
import type {
  BootstrapData,
  CaptureResult,
  ConversationBinding,
  DeepSeekStatus,
  Folder,
  FolderKind,
  IpcResult,
  MessagePage,
  Note,
  NoteTypeDefinition,
  Project,
  ScreenStatusEvent,
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
  app: {
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
  window: {
    getState: () => ipcRenderer.invoke('window:get-state') as Promise<WindowState>,
    collapse: () => ipcRenderer.invoke('window:collapse') as Promise<void>,
    expand: (focus = false) => ipcRenderer.invoke('window:expand', focus) as Promise<void>,
    toggle: () => ipcRenderer.invoke('window:toggle') as Promise<void>,
    setPinned: (pinned) => ipcRenderer.invoke('window:set-pinned', pinned) as Promise<Settings>,
    setSide: (side) => ipcRenderer.invoke('window:set-side', side) as Promise<Settings>,
    onStateChange: (callback) => subscribe<WindowState>('window:state-changed', callback)
  },
  chat: {
    send: (input) =>
      ipcRenderer.invoke('chat:send', input) as Promise<IpcResult<ConversationBinding | null>>,
    stop: () => ipcRenderer.invoke('chat:stop') as Promise<void>,
    messages: (projectId, before) =>
      ipcRenderer.invoke('chat:messages', projectId, before) as Promise<MessagePage>,
    onStream: (callback) => subscribe<StreamEvent>('chat:stream', callback),
    onScreenStatus: (callback) => subscribe<ScreenStatusEvent>('chat:screen-status', callback)
  },
  deepseek: {
    status: () => ipcRenderer.invoke('deepseek:status') as Promise<DeepSeekStatus>,
    reconnect: (projectId) =>
      ipcRenderer.invoke('deepseek:reconnect', projectId) as Promise<DeepSeekStatus>,
    show: () => ipcRenderer.invoke('deepseek:show') as Promise<void>,
    hide: () => ipcRenderer.invoke('deepseek:hide') as Promise<void>,
    bindCurrent: (projectId) =>
      ipcRenderer.invoke('deepseek:bind-current', projectId) as Promise<ConversationBinding>,
    bindUrl: (projectId, url) =>
      ipcRenderer.invoke('deepseek:bind-url', projectId, url) as Promise<ConversationBinding>,
    diagnose: () => ipcRenderer.invoke('deepseek:diagnose') as Promise<Record<string, unknown>>,
    readLast: () =>
      ipcRenderer.invoke('deepseek:read-last') as Promise<LastAssistantAnswer>,
    onStatusChange: (callback) => subscribe<DeepSeekStatus>('deepseek:status-changed', callback)
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
