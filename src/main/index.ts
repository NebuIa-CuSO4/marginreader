import {
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Tray
} from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BootstrapData,
  ChatMessage,
  ConversationBinding,
  IpcResult,
  Note,
  SelectionAction,
  Settings,
  StreamEvent,
  Vocab
} from '../shared/types'
import type { CreateProjectInput, SendMessageInput } from '../shared/api'
import { AppDatabase } from './database'
import { getDatabasePath, getResource, getTempDir } from './paths'
import { WindowManager } from './windowManager'
import { DeepSeekBridge, BridgeError } from './deepseekBridge'
import { CaptureService } from './capture'
import { SelectionService } from './selection'

let db: AppDatabase
let windows: WindowManager
let bridge: DeepSeekBridge
let capture: CaptureService
let selection: SelectionService
let tray: Tray | null = null
let isQuitting = false
const streamTexts = new Map<string, string>()
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
    binding: db.getBinding(finalId),
    messages: messagePage.messages,
    messagesHasMore: messagePage.hasMore,
    notes: db.listNotes(),
    vocab: db.listVocab(),
    folders: db.listFolders(),
    noteTypes: db.listNoteTypes(),
    settings: { ...merged, activeProjectId: finalId },
    windowState: windows.getState(),
    deepseek: await bridge.getStatus()
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

function handleStream(event: StreamEvent): void {
  if (event.phase === 'delta') {
    streamTexts.set(event.assistantId, event.text ?? '')
  } else if (event.phase === 'done') {
    streamTexts.delete(event.assistantId)
    db.updateMessage(event.assistantId, event.text ?? '', 'complete', event.reasoning ?? '')
  } else if (event.phase === 'error') {
    streamTexts.delete(event.assistantId)
    db.updateMessage(
      event.assistantId,
      event.text || event.error || '回答失败',
      'error',
      event.reasoning ?? ''
    )
  } else if (event.phase === 'stopped') {
    streamTexts.delete(event.assistantId)
    db.updateMessage(event.assistantId, event.text ?? '', 'interrupted', event.reasoning ?? '')
  }
  sendToRenderer('chat:stream', event)
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

  ipcMain.handle(
    'chat:messages',
    (_event, projectId: string, before?: { createdAt: number; id: string }) =>
      db.listMessagePage(projectId, 50, before)
  )

  ipcMain.handle('chat:send', async (_event, input: SendMessageInput): Promise<IpcResult<ConversationBinding | null>> => {
    const text = input.text.trim()
    if (!text) return { ok: false, code: 'EMPTY_MESSAGE', error: '消息不能为空。' }
    if (!db.getProject(input.projectId)) {
      return { ok: false, code: 'NO_PROJECT', error: '项目不存在。' }
    }
    const assistantId = input.assistantId || randomUUID()
    const displayText = input.displayText?.trim() || text
    const userMessage: ChatMessage = {
      id: randomUUID(),
      projectId: input.projectId,
      role: 'user',
      content: displayText,
      status: 'sending',
      createdAt: Date.now()
    }
    const assistantMessage: ChatMessage = {
      id: assistantId,
      projectId: input.projectId,
      role: 'assistant',
      content: '',
      reasoning: '',
      status: 'streaming',
      createdAt: Date.now() + 1
    }
    db.addMessage(userMessage)
    db.addMessage(assistantMessage)
    try {
      let imageDataUrl = input.imageDataUrl ?? ''
      let fallbackText = text
      if (!imageDataUrl && db.getSettings().autoScreenContext) {
        const screen = await capture.captureForContext()
        imageDataUrl = screen.imageDataUrl
        if (screen.text.trim()) {
          fallbackText = `【屏幕上下文｜自动读取】\n${screen.text.trim()}\n\n【我的问题】\n${text}`
        } else if (screen.error) {
          debug(`auto screen context failed: ${screen.error}`)
        }
      }
      const binding = await bridge.send(
        input.projectId,
        text,
        assistantId,
        Boolean(input.createIfMissing),
        { imageDataUrl, fallbackText }
      )
      db.updateMessage(userMessage.id, displayText, 'complete')
      return { ok: true, data: binding }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof BridgeError ? error.code : 'SEND_FAILED'
      db.updateMessage(userMessage.id, displayText, 'error')
      db.updateMessage(assistantId, message, 'error')
      sendToRenderer('chat:stream', {
        projectId: input.projectId,
        assistantId,
        phase: 'error',
        error: message
      } satisfies StreamEvent)
      return { ok: false, code, error: message }
    }
  })

  ipcMain.handle('chat:stop', async () => {
    await bridge.stop()
  })

  ipcMain.handle('deepseek:status', () => bridge.getStatus())
  ipcMain.handle('deepseek:show', () => bridge.showWindow())
  ipcMain.handle('deepseek:hide', () => bridge.hideWindow())
  ipcMain.handle('deepseek:bind-current', async (_event, projectId: string) => {
    const binding = await bridge.bindCurrent(projectId)
    sendToRenderer('deepseek:status-changed', await bridge.getStatus())
    return binding
  })
  ipcMain.handle('deepseek:bind-url', async (_event, projectId: string, url: string) => {
    const binding = await bridge.bindUrl(projectId, url)
    sendToRenderer('deepseek:status-changed', await bridge.getStatus())
    return binding
  })
  ipcMain.handle('deepseek:diagnose', () => bridge.diagnose())
  ipcMain.handle('deepseek:read-last', () => bridge.readLast())

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
        { label: '打开 DeepSeek 网页', click: () => void bridge.showWindow() },
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

async function bootstrap(): Promise<void> {
  debug('bootstrap start')
  app.setAppUserModelId('com.margin.reader')
  await fs.rm(getTempDir(), { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(getTempDir(), { recursive: true }).catch(() => undefined)

  debug(`db path ${getDatabasePath()}`)
  db = new AppDatabase(getDatabasePath())
  db.markStreamingInterrupted()
  const settings = db.getSettings()
  applyLaunchAtLogin(settings.launchAtLogin)
  debug('db ready')

  windows = new WindowManager()
  bridge = new DeepSeekBridge(db, (event) => {
    if (event.type === 'state') {
      sendToRenderer('deepseek:status-changed', event.state)
    } else if (event.type === 'stream') {
      handleStream(event.event)
    } else {
      sendToRenderer('chat:screen-status', event)
    }
  })
  // Warm the hidden, transparent page before the first send. Waiting until the
  // first message to create the BrowserWindow makes DeepSeek's first answer
  // lazy-render much later.
  void bridge.ensureWindow().catch((error) => {
    debug(`deepseek warmup failed: ${error instanceof Error ? error.message : String(error)}`)
  })
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
      bridge?.hideWindow()
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
  selection?.destroy()
  bridge?.destroy()
  db?.close()
})

app.on('window-all-closed', () => {
  app.quit()
})

process.on('uncaughtException', (error) => {
  console.error('[Margin] uncaught exception', error)
})
