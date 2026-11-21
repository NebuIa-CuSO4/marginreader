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
  ConversationInspection,
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
  SendMessageInput
} from '../shared/api'
import { AppDatabase } from './database'
import { getDatabasePath, getPreload, getRendererFile, getResource, getTempDir } from './paths'
import { WindowManager } from './windowManager'
import { stripVocabBlock } from '../shared/vocab'
import { ApiError, streamChat, testApiProvider } from './apiClient'
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
let activeRequest: { projectId: string; assistantId: string; controller: AbortController } | null =
  null
let inspectorWindow: BrowserWindow | null = null
const debugFile = process.env.MARGIN_DEBUG
  ? path.join(process.cwd(), 'margin-debug.log')
  : null

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

async function listProviders(): Promise<ApiProvider[]> {
  const providers = db.listApiProviders()
  return Promise.all(
    providers.map(async (provider) => ({
      ...provider,
      hasKey: await hasApiKey(provider.id)
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
  if (!(await hasApiKey(provider.id))) {
    return {
      phase: 'not_configured',
      message: `请为 ${provider.name} 配置 API Key。`,
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

function systemPrompt(projectTitle: string): string {
  return `你是页边（Margin），一个中文阅读与学习助手。当前项目：《${projectTitle}》。回答准确、清晰，优先使用 Markdown；数学公式使用 LaTeX。`
}

function trimContext(messages: ChatMessage[]): ChatMessage[] {
  const recent = messages.slice(-60)
  let chars = 0
  const kept: ChatMessage[] = []
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]
    chars += message.content.length
    if (kept.length >= 2 && chars > 70_000) break
    kept.unshift(message)
  }
  return kept
}

function historyMessages(
  projectTitle: string,
  messages: ChatMessage[],
  currentUser: string,
  imageDataUrl: string,
  supportsVision: boolean
): ApiMessage[] {
  const result: ApiMessage[] = [
    { role: 'system', content: systemPrompt(projectTitle) }
  ]
  trimContext(messages).forEach((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return
    result.push({
      role: message.role,
      content: message.role === 'assistant' ? stripVocabBlock(message.content) : message.content
    })
  })
  result.push({
    role: 'user',
    content:
      imageDataUrl && supportsVision
        ? [
            { type: 'text', text: currentUser },
            { type: 'image_url', image_url: { url: imageDataUrl } }
          ]
        : currentUser
  })
  return result
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
  const apiKey = await getApiKey(provider.id)
  if (!apiKey) throw new ApiError('API_KEY_MISSING', `请为 ${provider.name} 配置 API Key。`)
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
    ? { ...providerRecord, hasKey: await hasApiKey(providerRecord.id) }
    : null
  const messages = db.listMessages(projectId)
  const contextMessages = db.listContextMessages(projectId)
  const context: ConversationInspection['context'] = [
    { role: 'system', content: systemPrompt(project.title) },
    ...trimContext(contextMessages).map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.role === 'assistant' ? stripVocabBlock(message.content) : message.content
    }))
  ]
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
    context,
    stats,
    mismatched,
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

function registerIpc(): void {
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
      try {
        const { project, conversation, provider, apiKey } = await projectApiContext(
          input.projectId
        )
        if (!net.isOnline()) {
          return { ok: false, code: 'NETWORK_OFFLINE', error: '网络未连接。' }
        }
        if (activeRequest) {
          activeRequest.controller.abort()
        }
        const assistantId = input.assistantId || randomUUID()
        const displayText = input.displayText?.trim() || text
        let apiText = text
        let imageDataUrl = input.imageDataUrl ?? ''
        let screenText = ''
        if (!imageDataUrl && db.getSettings().autoScreenContext) {
          const screen = await capture.captureForContext()
          imageDataUrl = screen.imageDataUrl
          screenText = screen.text.trim()
          if (screenText) {
            apiText = `【屏幕上下文｜自动读取】\n${screenText}\n\n【我的问题】\n${text}`
          } else if (screen.error) {
            debug(`auto screen context failed: ${screen.error}`)
          }
        }
        if (imageDataUrl && !provider.supportsVision) {
          if (!screenText) {
            const ocr = await capture.ocrDataUrl(imageDataUrl)
            if (!ocr.trim()) {
              return {
                ok: false,
                code: 'API_VISION_UNSUPPORTED',
                error: '当前 API 模型不支持图片，且没有识别出截图文字。'
              }
            }
            apiText = `${apiText}\n\n【截图文字】\n${ocr.trim()}`
          }
          imageDataUrl = ''
        }

        const history = db.listContextMessages(input.projectId)
        const apiMessages = historyMessages(
          project.title,
          history,
          apiText,
          imageDataUrl,
          provider.supportsVision
        )
        const userMessage: ChatMessage = {
          id: randomUUID(),
          projectId: input.projectId,
          conversationId: conversation.id,
          role: 'user',
          content: displayText,
          status: 'complete',
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
        db.addMessage(userMessage)
        db.addMessage(assistantMessage)
        const controller = new AbortController()
        activeRequest = { projectId: input.projectId, assistantId, controller }
        let content = ''
        let reasoning = ''
        const emitDelta = (): void => {
          sendToRenderer('chat:stream', {
            projectId: input.projectId,
            assistantId,
            phase: 'delta',
            text: content,
            reasoning
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
            }
          )
          db.updateMessage(
            assistantId,
            result.content,
            'complete',
            result.reasoning,
            result.usage ?? undefined,
            conversation.model
          )
          sendToRenderer('chat:stream', {
            projectId: input.projectId,
            assistantId,
            phase: 'done',
            text: result.content,
            reasoning: result.reasoning
          } satisfies StreamEvent)
          await emitApiStatus()
          return { ok: true, data: conversation }
        } catch (error) {
          const apiError = error instanceof ApiError ? error : null
          if (apiError?.code === 'API_ABORTED') {
            db.updateMessage(assistantId, content, 'interrupted', reasoning)
            sendToRenderer('chat:stream', {
              projectId: input.projectId,
              assistantId,
              phase: 'stopped',
              text: content,
              reasoning
            } satisfies StreamEvent)
            return { ok: true, data: conversation }
          }
          const message = error instanceof Error ? error.message : String(error)
          const code = apiError?.code ?? 'API_ERROR'
          db.updateMessage(assistantId, content || message, 'error', reasoning)
          sendToRenderer('chat:stream', {
            projectId: input.projectId,
            assistantId,
            phase: 'error',
            text: content,
            reasoning,
            error: message
          } satisfies StreamEvent)
          await emitApiStatus()
          return { ok: false, code, error: message }
        } finally {
          if (activeRequest?.assistantId === assistantId) activeRequest = null
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof ApiError ? error.code : 'API_ERROR'
        return { ok: false, code, error: message }
      }
    }
  )

  ipcMain.handle('chat:stop', async () => {
    activeRequest?.controller.abort()
  })

  ipcMain.handle('chat:inspect', (_event, projectId: string) => inspectConversation(projectId))
  ipcMain.handle('chat:open-inspector', (_event, projectId: string) =>
    openInspectorWindow(projectId)
  )

  ipcMain.handle('api:providers', () => listProviders())

  ipcMain.handle(
    'api:save-provider',
    async (
      _event,
      input: Partial<ApiProvider> & { id: string; name: string; baseUrl: string }
    ) => {
      const provider = db.saveApiProvider(input)
      const settings = db.getSettings()
      if (!settings.defaultProviderId) {
        db.updateSettings({ defaultProviderId: provider.id, defaultModel: provider.defaultModel })
      }
      await emitApiStatus()
      return { ...provider, hasKey: await hasApiKey(provider.id) }
    }
  )

  ipcMain.handle('api:delete-provider', async (_event, id: string) => {
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
    if (!db.getApiProvider(providerId)) throw new Error('API 配置不存在。')
    if (!String(key ?? '').trim()) throw new Error('API Key 不能为空。')
    await saveApiKey(providerId, key)
    await emitApiStatus()
  })

  ipcMain.handle('api:clear-key', async (_event, providerId: string) => {
    await clearApiKey(providerId)
    await emitApiStatus()
  })

  ipcMain.handle('api:test', async (_event, providerId: string): Promise<ApiTestResult> => {
    const provider = db.getApiProvider(providerId)
    if (!provider) return { ok: false, message: 'API 配置不存在。' }
    const key = await getApiKey(providerId)
    if (!key) return { ok: false, message: '还没有配置 API Key。' }
    try {
      const result = await testApiProvider(provider, key)
      if (result.models.length) {
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
      return {
        ok: true,
        message: `连接成功${result.models.length ? `，发现 ${result.models.length} 个模型。` : '。'}`,
        models: result.models
      }
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
    const transcript = await streamChat(
      provider,
      apiKey,
      conversation.model || provider.defaultModel,
      apiMessages,
      controller.signal,
      () => undefined,
      () => undefined
    )
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
