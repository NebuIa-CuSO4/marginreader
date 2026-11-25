import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Tray
} from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  ApiConversation,
  ApiProvider,
  ApiStatus,
  BootstrapData,
  ChatMessage,
  ChatRequestLog,
  ConversationInspection,
  DeepSeekQuota,
  DeepSeekUsageReport,
  IpcResult,
  Note,
  SelectionAction,
  Settings,
  StreamEvent,
  Vocab
} from '../shared/types'
import type {
  ApiTestResult,
  CreateProjectInput,
  ExcerptInput,
  ExcerptResult,
  HistoryFilter,
  HistoryPreview,
  SendMessageInput
} from '../shared/api'
import { isOfficialDeepSeek } from '../shared/types'
import { deepSeekToday, readCodexQuota, readDeepSeekBalance } from './quota'
import { DeepSeekUsageError, importDeepSeekUsage } from './deepSeekUsage'
import { cleanRequestFiles } from './historyFiles'
import { AppDatabase } from './database'
import { getDatabasePath, getPreload, getRendererFile, getResource, getTempDir } from './paths'
import { WindowManager } from './windowManager'
import {
  buildRequest,
  describeRequest,
  newRequestId,
  readRequestLogs,
  saveRequestRecord,
  systemPrompt,
  writeRequestLog
} from './requestLog'
import { ApiError, listChatGPTModels, listProviderModels, streamChat, supportsWebSearch, testApiProvider } from './apiClient'
import { CHATGPT_PROVIDER_ID, OPENAI_RESOURCE, chatGPTAccessToken, connectChatGPT, disconnectChatGPT, hasChatGPTSession } from './chatgptAuth'
import type { ApiMessage } from './apiClient'
import {
  clearApiKey,
  getApiKey,
  hasApiKey,
  saveApiKey
} from './apiCredentials'
import { CaptureService } from './capture'
import { SelectionService } from './selection'

let db: AppDatabase
let windows: WindowManager
let capture: CaptureService
let selection: SelectionService
let tray: Tray | null = null
let isQuitting = false
const activeRequests = new Map<string, { assistantId: string; controller: AbortController }>()
let inspectorWindow: BrowserWindow | null = null
const REQUEST_LOG_LIMIT = 60

function getRequestLogDir(): string {
  return path.join(app.getPath('userData'), 'request-logs')
}
const debugFile = process.env.MARGIN_DEBUG
  ? path.join(process.cwd(), 'margin-debug.log')
  : null

function recordRendererDiagnostic(event: string): void {
  const file = path.join(app.getPath('userData'), 'renderer-errors.log')
  try {
    if ((fsSync.statSync(file, { throwIfNoEntry: false })?.size ?? 0) >= 65_536) {
      fsSync.writeFileSync(file, '', 'utf8')
    }
    fsSync.appendFileSync(file, `${new Date().toISOString()} ${event}\n`, 'utf8')
  } catch {
    // Rendering recovery still works if the diagnostic log is unavailable.
  }
}

function debug(message: string): void {
  if (!debugFile) return
  try {
    fsSync.appendFileSync(debugFile, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // ignore
  }
}

debug('main module loaded')

if (process.env.MARGIN_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.MARGIN_DEBUG_PORT)
}

function sendToRenderer(channel: string, payload: unknown): void {
  const win = windows?.window
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function currentSettings(): Settings {
  return db.getSettings()
}

function activeProjectId(settings: Settings): string {
  const project = db.getProject(settings.activeProjectId)
  if (project) return project.id
  return 'english-reading'
}

function providerHasCredentials(provider: ApiProvider): Promise<boolean> {
  return provider.kind === 'chatgpt' ? hasChatGPTSession() : hasApiKey(provider.id)
}

function providerCredential(provider: ApiProvider): Promise<string | null> {
  return provider.kind === 'chatgpt' ? chatGPTAccessToken() : getApiKey(provider.id)
}

async function listProviders(): Promise<ApiProvider[]> {
  const providers = db.listApiProviders()
  return Promise.all(
    providers.map(async (provider) => ({
      ...provider,
      hasKey: await providerHasCredentials(provider)
    }))
  )
}

async function apiStatusFor(projectId: string): Promise<ApiStatus> {
  if (!net.isOnline()) {
    return { phase: 'offline', message: '网络未连接，API 暂不可用。' }
  }
  const conversation = db.getConversation(projectId)
  const provider = conversation ? db.getApiProvider(conversation.providerId) : null
  if (!conversation || !provider) {
    return { phase: 'not_configured', message: '还没有配置 API 对话。' }
  }
  if (!(await providerHasCredentials(provider))) {
    return {
      phase: 'not_configured',
      message: provider.kind === 'chatgpt' ? '请在设置中连接 ChatGPT。' : `请为 ${provider.name} 配置 API Key。`,
      providerId: provider.id,
      model: conversation.model
    }
  }
  return {
    phase: 'ready',
    message: `${provider.name} · ${conversation.model || provider.defaultModel}`,
    providerId: provider.id,
    model: conversation.model || provider.defaultModel
  }
}

async function makeBootstrap(projectId?: string): Promise<BootstrapData> {
  const settings = db.getSettings()
  const activeId = activeProjectId(settings)
  if (projectId && db.getProject(projectId)) {
    db.updateSettings({ activeProjectId: projectId })
  }
  const finalId = projectId ?? activeId
  const merged = db.getSettings()
  const messagePage = db.listMessagePage(finalId, 50)
  return {
    projects: db.listProjects(),
    activeProjectId: finalId,
    apiProviders: await listProviders(),
    conversation: db.getConversation(finalId),
    apiStatus: await apiStatusFor(finalId),
    messages: messagePage.messages,
    messagesHasMore: messagePage.hasMore,
    notes: db.listNotes(),
    vocab: db.listVocab(),
    folders: db.listFolders(),
    noteTypes: db.listNoteTypes(),
    settings: { ...merged, activeProjectId: finalId },
    windowState: windows.getState()
  }
}

function registerShortcuts(settings: Settings): void {
  globalShortcut.unregisterAll()
  const entries: Array<[string, () => void]> = [
    [settings.toggleShortcut, () => windows.toggle(true)],
    [settings.screenshotShortcut, () => void capture.start()],
    [settings.selectionShortcut, () => void selection.captureSelection()]
  ]
  for (const [accelerator, handler] of entries) {
    if (!accelerator) continue
    try {
      const ok = globalShortcut.register(accelerator, handler)
      if (!ok) console.warn(`[Margin] shortcut registration failed: ${accelerator}`)
    } catch (error) {
      console.warn(`[Margin] shortcut error ${accelerator}`, error)
    }
  }
}

function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath
    })
  } catch (error) {
    console.warn('[Margin] failed to update login item', error)
  }
}

async function projectApiContext(projectId: string): Promise<{
  project: NonNullable<ReturnType<AppDatabase['getProject']>>
  conversation: ApiConversation
  provider: ApiProvider
  apiKey: string
}> {
  const project = db.getProject(projectId)
  if (!project) throw new ApiError('NO_PROJECT', '项目不存在。')
  const conversation = db.getConversation(projectId)
  if (!conversation) throw new ApiError('NO_CONVERSATION', '当前项目还没有 API 对话。')
  const provider = db.getApiProvider(conversation.providerId)
  if (!provider) throw new ApiError('NO_PROVIDER', '当前项目的 API 配置不存在。')
  const apiKey = await providerCredential(provider)
  if (!apiKey) throw new ApiError('API_KEY_MISSING', provider.kind === 'chatgpt'
    ? '请在设置中连接 ChatGPT。' : `请为 ${provider.name} 配置 API Key。`)
  return { project, conversation, provider, apiKey }
}

async function emitApiStatus(): Promise<void> {
  const status = await apiStatusFor(db.getSettings().activeProjectId)
  sendToRenderer('api:status-changed', status)
}

async function inspectConversation(projectId: string): Promise<ConversationInspection> {
  const project = db.getProject(projectId)
  if (!project) throw new Error('项目不存在。')
  const conversation = db.getConversation(projectId)
  const providerRecord = conversation ? db.getApiProvider(conversation.providerId) : null
  const provider = providerRecord
    ? { ...providerRecord, hasKey: await providerHasCredentials(providerRecord) }
    : null
  const messages = db.listMessages(projectId)
  const stats = {
    total: messages.length,
    user: messages.filter((message) => message.role === 'user').length,
    assistant: messages.filter((message) => message.role === 'assistant').length,
    complete: messages.filter((message) => message.status === 'complete').length,
    error: messages.filter((message) => message.status === 'error').length,
    interrupted: messages.filter((message) => message.status === 'interrupted').length,
    other: messages.filter(
      (message) => !['complete', 'error', 'interrupted'].includes(message.status)
    ).length
  }
  const mismatched = conversation
    ? messages.filter((message) => message.conversationId !== conversation.id).length
    : messages.filter((message) => message.conversationId).length
  return {
    project,
    conversation,
    provider,
    messages,
    systemPrompt: systemPrompt(project.title),
    stats,
    mismatched,
    logs: await readRequestLogs(getRequestLogDir(), REQUEST_LOG_LIMIT),
    logLimit: REQUEST_LOG_LIMIT,
    theme: db.getSettings().theme
  }
}

async function loadInspectorPage(window: BrowserWindow, projectId: string): Promise<void> {
  const query = new URLSearchParams({ view: 'inspector', projectId }).toString()
  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${query}`)
  } else {
    await window.loadFile(getRendererFile('index.html'), {
      query: { view: 'inspector', projectId }
    })
  }
}

async function openInspectorWindow(projectId: string): Promise<void> {
  const project = db.getProject(projectId)
  if (!project) throw new Error('项目不存在。')
  if (inspectorWindow && !inspectorWindow.isDestroyed()) {
    inspectorWindow.setTitle(`页边 · ${project.title} · 本地会话`)
    await loadInspectorPage(inspectorWindow, projectId)
    inspectorWindow.show()
    inspectorWindow.focus()
    return
  }
  inspectorWindow = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: `页边 · ${project.title} · 本地会话`,
    icon: getResource('icon.png'),
    backgroundColor: '#f4f1ea',
    webPreferences: {
      preload: getPreload('index'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  inspectorWindow.setMenu(null)
  inspectorWindow.center()
  inspectorWindow.once('ready-to-show', () => inspectorWindow?.show())
  inspectorWindow.on('closed', () => {
    inspectorWindow = null
  })
  await loadInspectorPage(inspectorWindow, projectId)
  if (!inspectorWindow.isVisible()) inspectorWindow.show()
  inspectorWindow.focus()
}

let historyBusy = false

async function manageHistory(input: HistoryFilter, remove = false): Promise<HistoryPreview> {
  if (!input || typeof input.messages !== 'boolean' || typeof input.logs !== 'boolean' ||
      typeof input.images !== 'boolean' || !Number.isSafeInteger(input.before) ||
      input.before > Date.now() - 86_400_000 || input.before < 0 ||
      (input.messages && !db.getProject(input.projectId))) {
    throw new Error('清理范围无效。')
  }
  if (historyBusy) throw new Error('正在清理，请稍后重试。')
  if (remove && input.messages && activeRequests.has(input.projectId)) {
    throw new Error('请等本项目的回复完成再清理。')
  }
  if (remove) historyBusy = true
  try {
    const cutoff = input.messages ? db.historyCutoff(input.projectId, input.before) : 0
    const messages = input.messages ? (remove ? db.deleteMessagesBefore(input.projectId, cutoff)
      : db.countMessagesBefore(input.projectId, cutoff)) : 0
    const files = await cleanRequestFiles(getRequestLogDir(), input, remove)
    if (remove && inspectorWindow && !inspectorWindow.isDestroyed()) inspectorWindow.webContents.reload()
    return { messages, ...files }
  } finally {
    if (remove) historyBusy = false
  }
}

function registerIpc(): void {
  ipcMain.handle('history:preview', (_event, input: HistoryFilter) => manageHistory(input))
  ipcMain.handle('history:remove', (_event, input: HistoryFilter) => manageHistory(input, true))
  ipcMain.on('app:renderer-error', (_event, area: string, name: string) => {
    if (area !== 'app' && area !== 'markdown') return
    const kind = typeof name === 'string' && /^[\w]{1,40}$/.test(name) ? name : 'Error'
    recordRendererDiagnostic(`${area}: ${kind}`)
  })
  ipcMain.handle('app:bootstrap', async () => makeBootstrap())

  ipcMain.handle('app:activate-project', async (_event, projectId: string) => {
    if (!db.getProject(projectId)) throw new Error('项目不存在')
    db.updateSettings({ activeProjectId: projectId })
    return makeBootstrap(projectId)
  })

  ipcMain.handle('app:create-project', async (_event, input: CreateProjectInput) => {
    const project = db.createProject(input.kind, input.title, input.author ?? '')
    db.updateSettings({ activeProjectId: project.id })
    return project
  })

  ipcMain.handle('app:delete-project-preview', (_event, projectId: string) =>
    db.getProjectUsage(projectId)
  )

  ipcMain.handle('app:delete-project', async (_event, projectId: string) => {
    if (projectId === 'english-reading') throw new Error('英语阅读是内置项目，不能删除')
    if (activeRequests.has(projectId)) throw new Error('请停止该项目的生成后再删除。')
    db.deleteProject(projectId)
    const settings = db.getSettings()
    if (settings.activeProjectId === projectId) db.updateSettings({ activeProjectId: 'english-reading' })
  })

  ipcMain.handle('app:update-settings', async (_event, patch: Partial<Settings>) => {
    const before = db.getSettings()
    const next = db.updateSettings(patch)
    windows.applySettings(next)
    if (
      before.toggleShortcut !== next.toggleShortcut ||
      before.screenshotShortcut !== next.screenshotShortcut ||
      before.selectionShortcut !== next.selectionShortcut
    ) {
      registerShortcuts(next)
    }
    if (before.launchAtLogin !== next.launchAtLogin) {
      applyLaunchAtLogin(next.launchAtLogin)
    }
    sendToRenderer('window:state-changed', windows.getState())
    return next
  })

  ipcMain.handle('app:copy-text', async (_event, text: string) => {
    await clipboard.writeText(String(text ?? ''))
  })

  ipcMain.handle(
    'app:save-text-file',
    async (_event, input: { fileName: string; content: string }) => {
      const defaultName = String(input?.fileName || 'code.txt').replace(/[\\/:*?"<>|]/g, '-')
      const result = await dialog.showSaveDialog({
        title: '保存代码',
        defaultPath: defaultName,
        filters: [
          { name: '代码文件', extensions: ['txt', 'py', 'js', 'ts', 'tsx', 'jsx', 'json', 'md'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePath) return null
      await fs.writeFile(result.filePath, String(input?.content ?? ''), 'utf8')
      return result.filePath
    }
  )

  ipcMain.handle('app:export-data', async () => {
    const parent = windows.window
    const options = {
      title: '导出页边数据',
      defaultPath: `margin-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, JSON.stringify(db.exportAll(), null, 2), 'utf8')
    return result.filePath
  })

  ipcMain.handle('window:get-state', () => windows.getState())
  ipcMain.handle('window:collapse', () => windows.collapse())
  ipcMain.handle('window:expand', (_event, focus = false) => windows.expand(Boolean(focus)))
  ipcMain.handle('window:toggle', () => windows.toggle(true))
  ipcMain.handle('window:set-pinned', async (_event, pinned: boolean) => {
    const settings = db.updateSettings({ pinned: Boolean(pinned) })
    windows.setPinned(settings.pinned)
    sendToRenderer('window:state-changed', windows.getState())
    return settings
  })
  ipcMain.handle('window:set-side', async (_event, side: 'right' | 'top') => {
    const next = db.updateSettings({ dockSide: side })
    windows.setSide(next.dockSide)
    sendToRenderer('window:state-changed', windows.getState())
    return next
  })
  ipcMain.handle('window:close-current', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle(
    'chat:messages',
    (_event, projectId: string, before?: { createdAt: number; id: string }) =>
      db.listMessagePage(projectId, 50, before)
  )

  ipcMain.handle(
    'chat:send',
    async (_event, input: SendMessageInput): Promise<IpcResult<ApiConversation | null>> => {
      const text = input.text.trim()
      if (!text) return { ok: false, code: 'EMPTY_MESSAGE', error: '消息不能为空。' }
      if (activeRequests.has(input.projectId)) return { ok: false, code: 'BUSY', error: '该项目正在生成回答。' }
      const assistantId = input.assistantId || randomUUID()
      const controller = new AbortController()
      activeRequests.set(input.projectId, { assistantId, controller })
      try {
        const { project, conversation, provider, apiKey } = await projectApiContext(
          input.projectId
        )
        if (!net.isOnline()) {
          return { ok: false, code: 'NETWORK_OFFLINE', error: '网络未连接。' }
        }
        const webSearch = input.webSearch === true
        if (webSearch && !supportsWebSearch(provider)) {
          return { ok: false, code: 'SEARCH_UNSUPPORTED', error: '当前 API 未配置原生联网搜索。' }
        }
        const displayText = input.displayText?.trim() || text
        const model = conversation.model || provider.defaultModel
        const settings = db.getSettings()
        let imageForRequest = input.imageDataUrl ?? ''
        let ocrText = ''
        let screenContextApplied = false
        if (!imageForRequest && settings.autoScreenContext) {
          const screen = await capture.captureForContext(!provider.supportsVision, settings.archiveRequestImages)
          imageForRequest = screen.imageDataUrl
          ocrText = screen.text
          screenContextApplied = Boolean(imageForRequest || ocrText)
          if (screen.error) debug('auto screen context capture failed')
        } else if (imageForRequest && !provider.supportsVision) {
          ocrText = await capture.ocrDataUrl(imageForRequest)
        }
        const requestId = newRequestId()
        const { built, log } = buildRequest(
          input.projectId,
          assistantId,
          requestId,
          project.title,
          db.listContextMessages(input.projectId),
          text,
          displayText,
          imageForRequest,
          screenContextApplied,
          ocrText,
          { id: provider.id, name: provider.name, supportsVision: provider.supportsVision },
          model
        )
        if (!settings.archiveRequestImages) log.images = []
        if (built.imageOmitted) {
          await writeRequestLog(getRequestLogDir(), { ...log, error: '模型不支持图片，且 OCR 没有识别出文字' })
          return {
            ok: false,
            code: 'API_VISION_UNSUPPORTED',
            error: '当前 API 模型不支持图片，且没有识别出截图文字。'
          }
        }
        log.webSearch = webSearch
        const apiMessages = built.messages
        const userMessage: ChatMessage = {
          id: input.userId || randomUUID(),
          projectId: input.projectId,
          conversationId: conversation.id,
          role: 'user',
          content: displayText,
          status: 'sending',
          createdAt: Date.now(),
          model: conversation.model
        }
        const assistantMessage: ChatMessage = {
          id: assistantId,
          projectId: input.projectId,
          conversationId: conversation.id,
          role: 'assistant',
          content: '',
          reasoning: '',
          status: 'streaming',
          createdAt: Date.now() + 1,
          model: conversation.model
        }
        if (controller.signal.aborted) return { ok: false, code: 'API_ABORTED', error: '已停止生成。' }
        db.addMessage(userMessage)
        db.addMessage(assistantMessage)
        let content = ''
        let reasoning = ''
        let requestLog: ChatRequestLog = { ...log, images: [] }
        try {
          requestLog = await writeRequestLog(getRequestLogDir(), { ...log })
        } catch (error) {
          debug(`request log failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        const finishLog = async (
          outcome: 'done' | 'stopped' | 'error',
          extra: Record<string, unknown> = {}
        ): Promise<void> => {
          try {
            await saveRequestRecord(getRequestLogDir(), {
              ...requestLog,
              searchStatus: log.searchStatus,
              logId: requestLog.requestId,
              outcome,
              answer: content,
              reasoning,
              ...extra
            })
          } catch (error) {
            debug(`request log update failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        const emitDelta = (): void => {
          sendToRenderer('chat:stream', {
            projectId: input.projectId,
            assistantId,
            phase: 'delta',
            text: content,
            reasoning,
            searchStatus: log.searchStatus
          } satisfies StreamEvent)
        }
        try {
          const result = await streamChat(
            provider,
            apiKey,
            conversation.model || provider.defaultModel,
            apiMessages,
            controller.signal,
            (value) => {
              content = value
              emitDelta()
            },
            (value) => {
              reasoning = value
              emitDelta()
            },
            webSearch,
            (status) => { log.searchStatus = status; emitDelta() }
          )
          db.updateMessage(userMessage.id, displayText, 'complete')
          db.updateMessage(
            assistantId,
            result.content,
            'complete',
            result.reasoning,
            result.usage ?? undefined,
            model,
            result.searchStatus
          )
          content = result.content
          log.searchStatus = result.searchStatus
          await finishLog('done', { usage: result.usage, finishReason: result.finishReason })
          sendToRenderer('chat:stream', {
            projectId: input.projectId,
            assistantId,
            phase: 'done',
            text: result.content,
            reasoning: result.reasoning,
            searchStatus: result.searchStatus
          } satisfies StreamEvent)
          await emitApiStatus()
          return { ok: true, data: conversation }
        } catch (error) {
          const apiError = error instanceof ApiError ? error : null
          if (apiError?.code === 'API_ABORTED') {
            db.updateMessage(userMessage.id, displayText, 'complete')
            db.updateMessage(assistantId, content, 'interrupted', reasoning)
            await finishLog('stopped')
            sendToRenderer('chat:stream', {
              projectId: input.projectId,
              assistantId,
              phase: 'stopped',
              text: content,
              reasoning
            } satisfies StreamEvent)
            return { ok: false, code: 'API_ABORTED', error: '已停止生成。' }
          }
          const message = error instanceof Error ? error.message : String(error)
          const code = apiError?.code ?? 'API_ERROR'
          db.updateMessage(userMessage.id, displayText, content ? 'complete' : 'error')
          if (log.searchStatus === 'searching') log.searchStatus = 'failed'
          db.updateMessage(assistantId, content || message, 'error', reasoning, undefined, model, log.searchStatus)
          await finishLog('error', { error: message, code })
          sendToRenderer('chat:stream', {
            projectId: input.projectId,
            assistantId,
            phase: 'error',
            text: content,
            reasoning,
            error: message,
            searchStatus: log.searchStatus
          } satisfies StreamEvent)
          await emitApiStatus()
          return { ok: false, code, error: message }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof ApiError ? error.code : 'API_ERROR'
        return { ok: false, code, error: message }
      } finally {
        activeRequests.delete(input.projectId)
      }
    }
  )

  ipcMain.handle('chat:stop', (_event, projectId: string, assistantId: string) => {
    const active = activeRequests.get(projectId)
    if (active?.assistantId === assistantId) active.controller.abort()
  })

  ipcMain.handle('chat:inspect', (_event, projectId: string) => inspectConversation(projectId))
  ipcMain.handle('chat:request-log-image', async (_event, requestId: string, fileName: string) => {
    if (!/^[\w.:-]+$/.test(requestId) || !/^[\w.:-]+\.(png|jpe?g|webp|gif)$/i.test(fileName)) {
      return null
    }
    try {
      if (!fileName.startsWith(requestId + '-') || !/^\d+\.(png|jpe?g|webp|gif)$/i.test(fileName.slice(requestId.length + 1))) return null
      const file = path.join(getRequestLogDir(), fileName)
      const data = await fs.readFile(file)
      const ext = path.extname(fileName).slice(1).toLowerCase()
      return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${data.toString('base64')}`
    } catch {
      return null
    }
  })
  ipcMain.handle('chat:open-inspector', (_event, projectId: string) =>
    openInspectorWindow(projectId)
  )

  ipcMain.handle('todos:list', () => db.listTodos())
  ipcMain.handle('todos:add', (_event, title: string) => db.addTodo(title))
  ipcMain.handle('todos:update', (_event, id: string, patch: { title?: string; completed?: boolean }) =>
    db.updateTodo(id, patch))
  ipcMain.handle('todos:remove', (_event, id: string) => db.removeTodo(id))

  ipcMain.handle('quota:deepseek', async (_event, providerId: string): Promise<DeepSeekQuota> => {
    const provider = db.getApiProvider(providerId)
    if (!provider || !isOfficialDeepSeek(provider)) throw new Error('请选择 DeepSeek 官方 API。')
    const today = await deepSeekToday(getRequestLogDir(), providerId)
    try {
      const key = await getApiKey(providerId)
      if (!key) throw new Error('请先在设置中配置 DeepSeek API Key。')
      return { today, balances: await readDeepSeekBalance(key) }
    } catch (error) {
      return { today, balances: [], balanceError: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('quota:codex', async () => {
    try {
      return { ok: true, data: await readCodexQuota() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '暂时无法读取 Codex 额度。' }
    }
  })

  ipcMain.handle('quota:deepseek-usage', (_event, providerId: string): DeepSeekUsageReport | null => {
    const provider = db.getApiProvider(providerId)
    return provider && isOfficialDeepSeek(provider) ? db.getDeepSeekUsage(providerId) : null
  })

  ipcMain.handle('quota:import-deepseek-usage', async (event, providerId: string): Promise<IpcResult<DeepSeekUsageReport | null>> => {
    try {
      const provider = db.getApiProvider(providerId)
      if (!provider || !isOfficialDeepSeek(provider)) throw new DeepSeekUsageError('请选择 DeepSeek 官方 API。')
      const previousKey = await getApiKey(providerId)
      const parent = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: '选择当前 DeepSeek 账户的官方用量导出',
        filters: [{ name: 'DeepSeek 用量导出', extensions: ['zip'] }],
        properties: ['openFile']
      }
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return { ok: true, data: null }
      const report = await importDeepSeekUsage(result.filePaths[0])
      const currentKey = await getApiKey(providerId)
      const current = db.getApiProvider(providerId)
      if (!current || !isOfficialDeepSeek(current) || previousKey !== currentKey) {
        throw new DeepSeekUsageError('DeepSeek API 配置已更改，请重新选择该账户的用量导出。')
      }
      db.saveDeepSeekUsage(providerId, report)
      return { ok: true, data: report }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof DeepSeekUsageError
          ? error.message : '无法读取用量导出。请选择 DeepSeek 官网下载的原始 ZIP。'
      }
    }
  })

  ipcMain.handle('api:providers', () => listProviders())

  ipcMain.handle('api:connect-chatgpt', async () => {
    await connectChatGPT()
    const key = await chatGPTAccessToken()
    if (!key) throw new Error('没有可用的 ChatGPT 授权。')
    const models = await listChatGPTModels(key)
    const previous = db.getApiProvider(CHATGPT_PROVIDER_ID)
    const defaultModel = previous && models.includes(previous.defaultModel) ? previous.defaultModel : models[0]
    const provider = db.saveApiProvider({
      id: CHATGPT_PROVIDER_ID, name: 'ChatGPT 订阅', kind: 'chatgpt',
      baseUrl: OPENAI_RESOURCE, models, defaultModel,
      supportsVision: previous?.supportsVision ?? false
    })
    for (const project of db.listProjects()) {
      const conversation = db.getConversation(project.id)
      if (conversation?.providerId === provider.id && !models.includes(conversation.model)) {
        db.updateConversation(project.id, { model: defaultModel })
      }
    }
    const settings = db.getSettings()
    if (settings.defaultProviderId === provider.id && !models.includes(settings.defaultModel)) {
      db.updateSettings({ defaultModel })
    }
    await emitApiStatus()
    return { ...provider, hasKey: true }
  })

  ipcMain.handle('api:disconnect-chatgpt', async () => {
    await disconnectChatGPT()
    await emitApiStatus()
  })

  ipcMain.handle(
    'api:save-provider',
    async (
      _event,
      input: Partial<ApiProvider> & { id: string; name: string; baseUrl: string }
    ) => {
      if (!input.baseUrl?.trim()) throw new Error('Base URL 不能为空。')
      const current = db.getApiProvider(input.id)
      if (input.kind === 'chatgpt' || input.id === CHATGPT_PROVIDER_ID || current?.kind === 'chatgpt') {
        if (current?.kind !== 'chatgpt') throw new Error('请通过 ChatGPT 登录添加此服务。')
        return { ...db.saveApiProvider({ ...current, supportsVision: input.supportsVision }), hasKey: await hasChatGPTSession() }
      }
      const provider = db.saveApiProvider(input.kind === 'openai-responses' ? { ...input, baseUrl: OPENAI_RESOURCE } : input)
      if (!isOfficialDeepSeek(provider)) db.clearDeepSeekUsage(provider.id)
      const settings = db.getSettings()
      if (!settings.defaultProviderId) {
        db.updateSettings({ defaultProviderId: provider.id, defaultModel: provider.defaultModel })
      }
      const conversations = db
        .listProjects()
        .map((project) => db.getConversation(project.id))
        .filter((item): item is ApiConversation => Boolean(item && item.providerId === provider.id))
      for (const conversation of conversations) {
        if (!conversation.model && provider.defaultModel) {
          db.updateConversation(conversation.projectId, { model: provider.defaultModel })
        }
      }
      await emitApiStatus()
      return { ...provider, hasKey: await providerHasCredentials(provider) }
    }
  )

  ipcMain.handle('api:delete-provider', async (_event, id: string) => {
    if (id === CHATGPT_PROVIDER_ID) throw new Error('请使用断开 ChatGPT。')
    if (db.listApiProviders().length <= 1) {
      throw new Error('至少保留一个 API 配置。')
    }
    const usedBy = db.listProjects().filter(
      (project) => db.getConversation(project.id)?.providerId === id
    )
    if (usedBy.length > 0) {
      throw new Error(`仍有 ${usedBy.length} 个项目使用这个 API，请先切换这些项目的 API。`)
    }
    db.deleteApiProvider(id)
    await clearApiKey(id)
    const providers = db.listApiProviders()
    if (db.getSettings().defaultProviderId === id) {
      db.updateSettings({
        defaultProviderId: providers[0]?.id ?? '',
        defaultModel: providers[0]?.defaultModel ?? ''
      })
    }
    await emitApiStatus()
  })

  ipcMain.handle('api:save-key', async (_event, providerId: string, key: string) => {
    if (db.getApiProvider(providerId)?.kind === 'chatgpt') throw new Error('ChatGPT 使用账号授权。')
    if (!db.getApiProvider(providerId)) throw new Error('API 配置不存在。')
    if (!String(key ?? '').trim()) throw new Error('API Key 不能为空。')
    const previousKey = await getApiKey(providerId)
    await saveApiKey(providerId, key)
    if (previousKey !== key.trim()) db.clearDeepSeekUsage(providerId)
    await emitApiStatus()
  })

  ipcMain.handle('api:clear-key', async (_event, providerId: string) => {
    await clearApiKey(providerId)
    db.clearDeepSeekUsage(providerId)
    await emitApiStatus()
  })

  ipcMain.handle(
    'api:test',
    async (
      _event,
      providerId: string,
      options?: { model?: string; probeImages?: boolean }
    ): Promise<ApiTestResult> => {
      const provider = db.getApiProvider(providerId)
      if (!provider) return { ok: false, message: 'API 配置不存在。' }
      const model = options?.model?.trim() || provider.defaultModel
      try {
        const key = await providerCredential(provider)
        if (!key) return { ok: false, message: '请先配置密钥或连接 ChatGPT。' }
        const result = await testApiProvider(provider, key, model, Boolean(options?.probeImages))
        if (result.models.length && provider.kind !== 'chatgpt') {
          db.saveApiProvider({
            ...provider,
            models: Array.from(new Set([...provider.models, ...result.models])),
            defaultModel:
              provider.defaultModel && result.models.includes(provider.defaultModel)
                ? provider.defaultModel
                : result.models[0]
          })
        }
        await emitApiStatus()
        const vision = result.vision
        return {
          ok: result.chat.ok && (vision ? vision.ok : true),
          message: [result.chat.message, vision?.message].filter(Boolean).join(' '),
          models: result.models,
          supportsVision: vision?.ok
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle('api:refresh-models', async (_event, providerId: string) => {
    const provider = db.getApiProvider(providerId)
    if (!provider) throw new Error('API 配置不存在。')
    const key = await providerCredential(provider)
    if (!key) throw new Error('请先配置密钥或连接 ChatGPT。')
    const models = await listProviderModels(provider, key)
    const saved = db.saveApiProvider({
      ...provider,
      models: provider.kind === 'chatgpt' ? models : [...new Set([...models, ...provider.models])]
    })
    return { ...saved, hasKey: true }
  })

  ipcMain.handle('api:test-search', async (_event, providerId: string, model: string): Promise<ApiTestResult> => {
    try {
      const provider = db.getApiProvider(providerId)
      if (!provider || !supportsWebSearch(provider)) throw new Error('此服务未配置原生联网搜索。')
      const key = await providerCredential(provider)
      if (!key) throw new Error('请先配置密钥或连接 ChatGPT。')
      const result = await streamChat(provider, key, model || provider.defaultModel, [
        { role: 'user', content: '请联网检索今天中国政府网发布的一条消息，给出标题和来源链接。' }
      ], AbortSignal.timeout(60_000), () => undefined, () => undefined, true)
      const searchStatus = result.searchStatus
      return { ok: searchStatus === 'searched', searchStatus,
        message: searchStatus === 'searched' ? '模型已完成联网搜索。'
          : searchStatus === 'failed' ? '模型尝试搜索，但搜索失败。' : '模型已回答，本轮未调用搜索。' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('api:status', () => apiStatusFor(db.getSettings().activeProjectId))

  ipcMain.handle(
    'api:set-conversation',
    async (
      _event,
      input: { projectId: string; providerId?: string; model?: string }
    ): Promise<ApiConversation | null> => {
      const conversation = db.getConversation(input.projectId)
      if (!conversation) return null
      const providerId = input.providerId ?? conversation.providerId
      const provider = db.getApiProvider(providerId)
      if (!provider) throw new Error('API 配置不存在。')
      const model = input.model ?? (providerId === conversation.providerId ? conversation.model : provider.defaultModel)
      if (provider.kind === 'chatgpt' && !provider.models.includes(model)) throw new Error('请从 ChatGPT 账号的可用模型中选择。')
      const next = db.updateConversation(input.projectId, { providerId, model })
      const settings = db.getSettings()
      if (settings.activeProjectId === input.projectId) {
        db.updateSettings({ defaultProviderId: providerId, defaultModel: model })
      }
      await emitApiStatus()
      return next
    }
  )

  ipcMain.handle('capture:start', () => capture.start())

  ipcMain.handle('folders:list', (_event, kind?: 'note' | 'vocab') => db.listFolders(kind))
  ipcMain.handle(
    'folders:create',
    (
      _event,
      input: { kind: 'note' | 'vocab'; parentId?: string | null; name: string; color?: string }
    ) => db.createFolder(input)
  )
  ipcMain.handle('folders:rename', (_event, id: string, name: string) => db.renameFolder(id, name))
  ipcMain.handle('folders:move', (_event, id: string, parentId: string | null) =>
    db.moveFolder(id, parentId)
  )
  ipcMain.handle('folders:remove', (_event, id: string) => db.deleteFolder(id))

  ipcMain.handle('note-types:list', () => db.listNoteTypes())
  ipcMain.handle(
    'note-types:save',
    (_event, input: { id?: string; name: string; color?: string }) => db.saveNoteType(input)
  )
  ipcMain.handle('note-types:remove', (_event, id: string) => db.deleteNoteType(id))

  ipcMain.handle('excerpt:run', async (_event, input: ExcerptInput): Promise<ExcerptResult> => {
    const project = db.getProject(input.projectId)
    if (!project) throw new Error('项目不存在。')
    const text = (input.text ?? '').trim()
    let imageDataUrl = input.imageDataUrl ?? ''
    const originalImage = imageDataUrl
    if (!text && !imageDataUrl) throw new Error('没有可摘抄的文字或图片。')
    const { conversation, provider, apiKey } = await projectApiContext(input.projectId)
    let prompt = excerptPrompt(text, Boolean(imageDataUrl))
    if (imageDataUrl && !provider.supportsVision) {
      const ocr = await capture.ocrDataUrl(imageDataUrl)
      if (!ocr.trim()) throw new Error('当前 API 模型不支持图片，且没有识别出截图文字。')
      prompt = `${prompt}\n\n【截图文字】\n${ocr.trim()}`
      imageDataUrl = ''
    }
    const apiMessages: ApiMessage[] = [
      { role: 'system', content: '你是逐字摘抄器，只输出整理后的原文。' },
      {
        role: 'user',
        content:
          imageDataUrl && provider.supportsVision
            ? [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageDataUrl } }
              ]
            : prompt
      }
    ]
    const controller = new AbortController()
    const model = conversation.model || provider.defaultModel
    const requestId = newRequestId()
    let excerptLog: ChatRequestLog | undefined
    try {
      excerptLog = await writeRequestLog(getRequestLogDir(), {
        requestId,
        projectId: input.projectId,
        assistantId: 'excerpt',
        createdAt: Date.now(),
        provider: provider.name,
        providerId: provider.id,
        model,
        supportsVision: provider.supportsVision,
        displayText: text || '（截图摘抄）',
        apiText: prompt,
        screenContextApplied: false,
        imageAttached: Boolean(imageDataUrl),
        imageOmitted: false,
        ocrApplied: Boolean(input.imageDataUrl) && Boolean(prompt.includes('【截图文字】')),
        trim: {
          historyCount: 0,
          sentMessageCount: apiMessages.length,
          charLimit: 0,
          messageLimit: 0
        },
        request: describeRequest(apiMessages),
        images: originalImage && db.getSettings().archiveRequestImages ? [originalImage] : []
      })
    } catch (error) {
      debug(`excerpt request log failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const transcript = await streamChat(
      provider,
      apiKey,
      model,
      apiMessages,
      controller.signal,
      () => undefined,
      () => undefined
    )
    if (excerptLog) {
      try {
        await saveRequestRecord(getRequestLogDir(), { ...excerptLog, outcome: 'done',
          usage: transcript.usage ?? undefined, answer: transcript.content })
      } catch (error) {
        debug(`excerpt usage log failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const raw = transcript.content
    let content = sanitizeExcerpt(raw)
    if (!content) throw new Error('API 没有返回摘抄内容。')
    let exact: boolean | null = null
    if (text) {
      exact = normalizeExcerptText(content) === normalizeExcerptText(text)
      if (!exact) content = text
    }
    const firstLine =
      content
        .split(/\r?\n/)
        .map((line) => line.replace(/[#*_`>~-]/g, '').trim())
        .find(Boolean) ?? ''
    const stamp = new Date().toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
    const title = imageDataUrl
      ? `截图摘抄 · ${stamp}`
      : (firstLine.slice(0, 28) || `摘抄 · ${stamp}`)
    const note = db.saveNote({
      projectId: input.projectId,
      title,
      content,
      tags: ['摘抄'],
      source: imageDataUrl ? '截图摘抄' : '划词摘抄'
    })
    return { note, exact }
  })

  ipcMain.handle('notes:list', (_event, projectId: string, query = '') => db.listNotes(projectId, query))
  ipcMain.handle('notes:save', (_event, note: Partial<Note> & { projectId: string; title: string }) =>
    db.saveNote(note)
  )
  ipcMain.handle('notes:remove', (_event, id: string) => db.deleteNote(id))

  ipcMain.handle('vocab:list', (_event, projectId: string, query = '') => db.listVocab(projectId, query))
  ipcMain.handle('vocab:save', (_event, item: Partial<Vocab> & { projectId: string; word: string }) =>
    db.saveVocab(item)
  )
  ipcMain.handle('vocab:review', (_event, id: string) => db.reviewVocab(id))
  ipcMain.handle('vocab:remove', (_event, id: string) => db.deleteVocab(id))

  ipcMain.on('selection:action', (_event, payload: SelectionAction) => {
    selection.hide()
    windows.focus()
    sendToRenderer('selection:action', payload)
  })
  ipcMain.on('toolbar:close', () => selection.hide())

  ipcMain.handle('app:show-error', (_event, message: string) => {
    void dialog.showMessageBox({ type: 'error', title: '页边', message })
  })
}

function createTray(): void {
  try {
    const image = nativeImage.createFromPath(getResource('icon.png'))
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 18, height: 18 }))
    tray.setToolTip('页边 Margin')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示页边', click: () => windows.focus() },
        { label: '重新加载界面', click: () => windows.window?.webContents.reload() },
        { label: '截图读取屏幕', click: () => void capture.start() },
        { type: 'separator' },
        { label: '退出页边', click: () => app.quit() }
      ])
    )
    tray.on('click', () => windows.focus())
  } catch (error) {
    debug(`tray failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const EXCERPT_RULES =
  '你是逐字摘抄器。必须一字不差地保留原文，不得改写、润色、总结、解释、补充、删除、纠正错别字或标点，不得添加原文没有的词句。只允许使用 Markdown 的标题、分段、列表和加粗来表达原文结构和重点。不要添加任何前言、说明、结论或代码围栏，直接输出整理后的原文。'

function excerptPrompt(text: string, hasImage: boolean): string {
  if (hasImage) {
    return `${EXCERPT_RULES}\n\n请逐字识别这张图片中的全部文字，按阅读顺序整理；图片里没有的文字一个字也不要添加。`
  }
  return `${EXCERPT_RULES}\n\n【原文开始】\n${text}\n【原文结束】`
}

function normalizeExcerptText(value: string): string {
  return value
    .replace(/```(?:markdown|md)?\s*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]/g, '')
    .replace(/^\s*(?:[-+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, '')
    .trim()
}

function sanitizeExcerpt(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

function backupBeforeApiMigration(): void {
  const dbPath = getDatabasePath()
  if (!fsSync.existsSync(dbPath)) return
  const backupPath = `${dbPath}.pre-0.2.0.bak`
  if (fsSync.existsSync(backupPath)) return
  try {
    const source = new DatabaseSync(dbPath)
    const escaped = backupPath.replace(/'/g, "''")
    source.exec(`VACUUM INTO '${escaped}'`)
    source.close()
    debug(`database backup created at ${backupPath}`)
  } catch (error) {
    debug(`database backup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function bootstrap(): Promise<void> {
  debug('bootstrap start')
  app.setAppUserModelId('com.margin.reader')
  await fs.rm(getTempDir(), { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(getTempDir(), { recursive: true }).catch(() => undefined)

  debug(`db path ${getDatabasePath()}`)
  backupBeforeApiMigration()
  db = new AppDatabase(getDatabasePath())
  db.markStreamingInterrupted()
  const settings = db.getSettings()
  applyLaunchAtLogin(settings.launchAtLogin)
  debug('db ready')

  windows = new WindowManager()
  capture = new CaptureService(
    windows,
    currentSettings,
    (result) => {
      windows.restoreAfterCapture()
      windows.expand(true)
      sendToRenderer('capture:result', result)
    },
    () => {
      selection?.hide()
    }
  )
  selection = new SelectionService((action, text) => {
    sendToRenderer('selection:action', { action, text })
  })

  registerIpc()
  const mainWindow = windows.create(settings)
  debug('main window created')
  let recoveredRenderer = false
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    recordRendererDiagnostic(`renderer-${details.reason}: ${details.exitCode}`)
    if (!isQuitting && !recoveredRenderer && !mainWindow.isDestroyed() && details.reason !== 'clean-exit') {
      recoveredRenderer = true
      mainWindow.webContents.reload()
    }
  })
  mainWindow.on('closed', () => {
    if (!isQuitting) app.quit()
  })
  registerShortcuts(settings)
  createTray()
  debug('shortcuts registered')

  if (process.env.MARGIN_SMOKE) {
    setTimeout(() => {
      void mainWindow
        .capturePage()
        .then((image) => fs.writeFile(process.env.MARGIN_SMOKE as string, image.toPNG()))
        .catch((error) => console.error('[Margin] smoke capture failed', error))
    }, 2500)
  }

  app.on('second-instance', () => windows.focus())
  app.on('activate', () => windows.focus())
}

const gotLock = app.requestSingleInstanceLock()
debug(`single instance lock=${gotLock}`)
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(() => {
    debug('app ready')
    return bootstrap()
  }).catch((error) => {
    debug(`startup failed: ${error instanceof Error ? error.stack : String(error)}`)
    console.error('[Margin] startup failed', error)
    dialog.showErrorBox('页边启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  })
}

app.on('before-quit', () => {
  isQuitting = true
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
  inspectorWindow?.destroy()
  inspectorWindow = null
  selection?.destroy()
  db?.close()
})

app.on('window-all-closed', () => {
  app.quit()
})

process.on('uncaughtException', (error) => {
  console.error('[Margin] uncaught exception', error)
})
