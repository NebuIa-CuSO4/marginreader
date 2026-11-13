import { BrowserWindow, ipcMain, net, screen, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import type { LastAssistantAnswer } from '../shared/api'
import type { ConversationBinding, DeepSeekStatus, StreamEvent } from '../shared/types'
import { extractConversationId, normalizeConversationUrl } from '../shared/conversation'
import type { AppDatabase } from './database'
import { getPreload } from './paths'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface BridgeResponse {
  id: string
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

interface StreamPayload extends StreamEvent {
  requestId: string
}

export interface SendOptions {
  imageDataUrl?: string
  fallbackText?: string
}

export class BridgeError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const BASE_URL = 'https://chat.deepseek.com/'

export class DeepSeekBridge {
  private win: BrowserWindow | null = null
  private pending = new Map<string, PendingRequest>()
  private lastState: DeepSeekStatus = {
    phase: 'not_started',
    url: '',
    externalId: null,
    loginRequired: false,
    composerReady: false,
    pageTitle: '',
    message: '尚未连接 DeepSeek 网页'
  }
  private quitting = false
  private loading = false
  private stateRefreshTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly db: AppDatabase,
    private readonly emit: (
      event:
        | { type: 'state'; state: DeepSeekStatus }
        | { type: 'stream'; event: StreamEvent }
        | {
            type: 'screen'
            projectId: string
            imageAttached: boolean
            usedFallbackText: boolean
          }
    ) => void
  ) {
    ipcMain.on('deepseek:response', this.onResponse)
    ipcMain.on('deepseek:stream', this.onStream)
    ipcMain.on('deepseek:state', this.onState)
  }

  get window(): BrowserWindow | null {
    return this.win
  }

  async ensureWindow(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return this.win
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(1040, Math.max(720, area.width - 160))
    const height = Math.min(820, Math.max(560, area.height - 100))
    const win = new BrowserWindow({
      width,
      height,
      x: area.x + Math.round((area.width - width) / 2) - 120,
      y: area.y + Math.round((area.height - height) / 2),
      show: false,
      title: 'DeepSeek 网页 — 登录 / 备用',
      backgroundColor: '#0f1115',
      autoHideMenuBar: true,
      webPreferences: {
        preload: getPreload('deepseek'),
        partition: 'persist:deepseek-web',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    this.win = win
    win.removeMenu()
    win.setMenuBarVisibility(false)
    const chromeVersion = process.versions.chrome ?? '120.0.0.0'
    win.webContents.setUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
    )

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\/([a-z0-9-]+\.)*deepseek\.com(\/|$)/i.test(url)) {
        return { action: 'allow' }
      }
      if (/^https?:/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, url) => {
      if (!/^https:\/\//i.test(url)) event.preventDefault()
    })
    win.webContents.on('did-navigate', () => this.scheduleRefresh())
    win.webContents.on('did-navigate-in-page', () => this.scheduleRefresh())
    win.webContents.on('did-finish-load', () => this.scheduleRefresh())
    win.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
      if (code === -3) return
      this.lastState = {
        ...this.lastState,
        phase: 'error',
        url: validatedURL || this.lastState.url,
        message: `网页加载失败：${description}`
      }
      this.emit({ type: 'state', state: this.lastState })
    })
    win.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      win.setOpacity(0.01)
      win.setSkipTaskbar(true)
      win.setFocusable(false)
      win.setIgnoreMouseEvents(true, { forward: true })
    })
    win.on('closed', () => {
      this.win = null
    })

    await this.loadUrl(BASE_URL, 20_000).catch(() => undefined)
    // Keep the page in a visible, laid-out window so DeepSeek does not defer
    // rendering of the first answer until the user opens the panel. The window
    // is fully transparent, unfocusable and not in the taskbar.
    win.setOpacity(0.01)
    win.setSkipTaskbar(true)
    win.setFocusable(false)
    win.setIgnoreMouseEvents(true, { forward: true })
    win.showInactive()
    return win
  }

  async showWindow(): Promise<void> {
    const win = await this.ensureWindow()
    if (!net.isOnline()) {
      this.lastState = {
        ...this.lastState,
        phase: 'offline',
        composerReady: false,
        loginRequired: false,
        message: '网络未连接，请检查网络后点击“重连”。'
      }
      this.emit({ type: 'state', state: this.lastState })
    }
    if (
      net.isOnline() &&
      (this.lastState.phase === 'error' || !this.lastState.composerReady)
    ) {
      const current = win.webContents.getURL()
      const target = current.startsWith('http') ? current : BASE_URL
      await this.loadUrl(target, 15_000).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 700))
      await this.refreshState().catch(() => undefined)
    }
    win.setIgnoreMouseEvents(false)
    win.setOpacity(1)
    win.setSkipTaskbar(false)
    win.setFocusable(true)
    win.show()
    win.focus()
    this.scheduleRefresh()
  }

  hideWindow(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.setOpacity(0.01)
    win.setSkipTaskbar(true)
    win.setFocusable(false)
    win.setIgnoreMouseEvents(true, { forward: true })
  }

  async getStatus(): Promise<DeepSeekStatus> {
    if (!net.isOnline()) {
      this.lastState = {
        ...this.lastState,
        phase: 'offline',
        composerReady: false,
        loginRequired: false,
        message: '网络未连接，请检查网络后点击“重连”。'
      }
      return this.lastState
    }
    if (!this.win || this.win.isDestroyed()) {
      return {
        ...this.lastState,
        phase: this.lastState.phase === 'not_started' ? 'not_started' : this.lastState.phase,
        externalId: extractConversationId(this.lastState.url)
      }
    }
    if (this.loading) {
      return { ...this.lastState, phase: 'loading', message: '正在连接 DeepSeek 网页…' }
    }
    try {
      const page = (await this.request('getState', {}, 4000)) as {
        url: string
        title: string
        loginRequired: boolean
        composerReady: boolean
        host: string
      }
      const externalId = extractConversationId(page.url)
      const phase: DeepSeekStatus['phase'] = page.loginRequired
        ? 'login_required'
        : page.composerReady
          ? 'ready'
          : 'error'
      const message = page.loginRequired
        ? '请先在网页面板登录 DeepSeek'
        : page.composerReady
          ? 'DeepSeek 网页已连接'
          : '网页已打开，但没有找到输入框；请检查登录状态或页面结构'
      this.lastState = {
        phase,
        url: page.url,
        externalId,
        loginRequired: page.loginRequired,
        composerReady: page.composerReady,
        pageTitle: page.title,
        message
      }
      return this.lastState
    } catch (error) {
      this.lastState = {
        ...this.lastState,
        phase: 'error',
        message: error instanceof Error ? error.message : '无法读取 DeepSeek 网页状态'
      }
      return this.lastState
    }
  }

  async bindUrl(projectId: string, rawUrl: string): Promise<ConversationBinding> {
    const url = normalizeConversationUrl(rawUrl)
    const expected = extractConversationId(url)
    if (!expected) {
      throw new BridgeError('INVALID_URL', '没有从链接中识别出对话 ID。请粘贴完整的 DeepSeek 对话链接。')
    }
    const win = await this.ensureWindow()
    await this.loadUrl(url, 20_000)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const page = (await this.request('getState', {}, 5000)) as {
      url: string
      loginRequired: boolean
      composerReady: boolean
    }
    if (page.loginRequired) {
      throw new BridgeError('LOGIN_REQUIRED', '请先在网页面板登录 DeepSeek。')
    }
    const actual = extractConversationId(page.url) ?? extractConversationId(win.webContents.getURL())
    if (actual !== expected) {
      throw new BridgeError('URL_MISMATCH', '打开后的对话 ID 与链接不一致。请确认链接有效并且已登录。')
    }
    const binding: ConversationBinding = {
      projectId,
      provider: 'deepseek-web',
      externalId: actual,
      url: page.url || url,
      status: 'connected',
      updatedAt: Date.now()
    }
    this.db.upsertBinding(binding)
    await this.refreshState()
    return binding
  }

  async bindCurrent(projectId: string): Promise<ConversationBinding> {
    const win = await this.ensureWindow()
    const url = win.webContents.getURL()
    return this.bindUrl(projectId, url)
  }

  async send(
    projectId: string,
    text: string,
    assistantId: string,
    createIfMissing: boolean,
    options: SendOptions = {}
  ): Promise<ConversationBinding | null> {
    if (!net.isOnline()) {
      throw new BridgeError('NETWORK_OFFLINE', '网络未连接，请检查网络后点击“重连”。')
    }
    const win = await this.ensureWindow()
    let binding = this.db.getBinding(projectId)

    if (binding?.url) {
      const expected = binding.externalId ?? extractConversationId(binding.url)
      const current = win.webContents.getURL()
      const currentId = extractConversationId(current)
      if (!expected) {
        throw new BridgeError('BINDING_INVALID', '当前项目绑定的对话链接无效，请重新绑定。')
      }
      if (currentId !== expected || current !== binding.url) {
        await this.loadUrl(binding.url, 20_000)
        await new Promise((resolve) => setTimeout(resolve, 800))
        const page = (await this.request('getState', {}, 5000)) as {
          url: string
          loginRequired: boolean
          composerReady: boolean
        }
        if (page.loginRequired) {
          this.db.updateBindingStatus(projectId, 'login_required', page.url)
          throw new BridgeError('LOGIN_REQUIRED', 'DeepSeek 登录已失效，请打开网页面板重新登录。')
        }
        const actual = extractConversationId(page.url) ?? extractConversationId(win.webContents.getURL())
        if (actual !== expected) {
          this.db.updateBindingStatus(projectId, 'mismatch', page.url)
          throw new BridgeError(
            'URL_MISMATCH',
            '当前网页对话与项目绑定的对话不一致。应用已停止发送，以免发错对话。'
          )
        }
        binding = { ...binding, status: 'connected', url: page.url, updatedAt: Date.now() }
        this.db.upsertBinding(binding)
      }
    } else {
      if (!createIfMissing) {
        throw new BridgeError('NO_BINDING', '当前项目还没有绑定 DeepSeek 对话。')
      }
      await this.loadUrl(BASE_URL, 20_000)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const page = (await this.request('getState', {}, 5000)) as {
        url: string
        loginRequired: boolean
        composerReady: boolean
      }
      if (page.loginRequired) {
        throw new BridgeError('LOGIN_REQUIRED', '请先点击“打开网页”完成 DeepSeek 登录。')
      }
      if (!page.composerReady) {
        throw new BridgeError('COMPOSER_NOT_FOUND', '网页里没有找到输入框，请打开网页面板检查。')
      }
    }

    const sendResult = (await this.request(
      'send',
      {
        text,
        assistantId,
        projectId,
        fallbackText: options.fallbackText ?? text,
        imageDataUrl: options.imageDataUrl ?? ''
      },
      35_000
    )) as { imageAttached?: boolean; usedFallbackText?: boolean }
    if (options.imageDataUrl) {
      this.emit({
        type: 'screen',
        projectId,
        imageAttached: Boolean(sendResult?.imageAttached),
        usedFallbackText: Boolean(sendResult?.usedFallbackText)
      })
    }

    if (!binding) {
      binding = await this.captureNewBinding(projectId, win)
    } else {
      binding = {
        ...binding,
        url: win.webContents.getURL() || binding.url,
        status: 'connected',
        updatedAt: Date.now()
      }
      this.db.upsertBinding(binding)
    }
    await this.refreshState()
    return binding
  }

  private async captureNewBinding(projectId: string, win: BrowserWindow): Promise<ConversationBinding> {
    const started = Date.now()
    while (Date.now() - started < 10_000) {
      const url = win.webContents.getURL()
      const externalId = extractConversationId(url)
      if (externalId) {
        const binding: ConversationBinding = {
          projectId,
          provider: 'deepseek-web',
          externalId,
          url,
          status: 'connected',
          updatedAt: Date.now()
        }
        this.db.upsertBinding(binding)
        return binding
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const url = win.webContents.getURL()
    const binding: ConversationBinding = {
      projectId,
      provider: 'deepseek-web',
      externalId: null,
      url,
      status: 'unbound',
      updatedAt: Date.now()
    }
    this.db.upsertBinding(binding)
    return binding
  }

  async stop(): Promise<void> {
    if (!this.win || this.win.isDestroyed()) return
    try {
      await this.request('stop', {}, 4000)
    } catch {
      // ignore
    }
  }

  async diagnose(): Promise<Record<string, unknown>> {
    await this.ensureWindow()
    return (await this.request('diagnose', {}, 5000)) as Record<string, unknown>
  }

  async readLast(): Promise<LastAssistantAnswer> {
    await this.ensureWindow()
    const result = (await this.request('getLastAssistant', {}, 5000)) as {
      text?: string
      reasoning?: string
    }
    return {
      text: result?.text ?? '',
      reasoning: result?.reasoning ?? ''
    }
  }

  async reconnect(projectId?: string): Promise<DeepSeekStatus> {
    if (!net.isOnline()) {
      return this.refreshState()
    }
    const win = await this.ensureWindow()
    const binding = projectId ? this.db.getBinding(projectId) : null
    const target =
      binding?.url ||
      (win.webContents.getURL().startsWith('http') ? win.webContents.getURL() : BASE_URL)
    try {
      await this.loadUrl(target, 20_000)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    } catch {
      // getStatus below turns this into a visible error state.
    }
    return this.refreshState()
  }

  async refreshState(): Promise<DeepSeekStatus> {
    const state = await this.getStatus()
    this.emit({ type: 'state', state })
    return state
  }

  destroy(): void {
    this.quitting = true
    if (this.stateRefreshTimer) clearTimeout(this.stateRefreshTimer)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Bridge destroyed'))
    }
    this.pending.clear()
    ipcMain.removeListener('deepseek:response', this.onResponse)
    ipcMain.removeListener('deepseek:stream', this.onStream)
    ipcMain.removeListener('deepseek:state', this.onState)
    this.win?.destroy()
    this.win = null
  }

  private scheduleRefresh(): void {
    if (this.stateRefreshTimer) clearTimeout(this.stateRefreshTimer)
    this.stateRefreshTimer = setTimeout(() => {
      void this.refreshState().catch(() => undefined)
    }, 300)
  }

  private async loadUrl(url: string, timeout: number): Promise<void> {
    const win = await this.ensureWindow()
    this.loading = true
    this.lastState = { ...this.lastState, phase: 'loading', message: '正在连接 DeepSeek 网页…' }
    this.emit({ type: 'state', state: this.lastState })
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        win.webContents.removeListener('did-finish-load', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeout)
      win.webContents.once('did-finish-load', finish)
      win.loadURL(url).catch(() => finish())
    })
    this.loading = false
  }

  private request(type: string, payload: Record<string, unknown>, timeout = 12_000): Promise<unknown> {
    if (!this.win || this.win.isDestroyed()) {
      return Promise.reject(new BridgeError('WEB_NOT_READY', 'DeepSeek 网页还没有打开。'))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError('BRIDGE_TIMEOUT', 'DeepSeek 网页响应超时。请打开网页面板检查。'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.win?.webContents.send('deepseek:command', { id, type, payload })
    })
  }

  private onResponse = (_event: Electron.IpcMainEvent, response: BridgeResponse): void => {
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.ok) {
      pending.resolve(response.data)
    } else {
      pending.reject(
        new BridgeError(
          response.error?.code ?? 'BRIDGE_ERROR',
          response.error?.message ?? 'DeepSeek 网页桥接失败。'
        )
      )
    }
  }

  private onStream = (_event: Electron.IpcMainEvent, payload: StreamPayload): void => {
    const { requestId: _requestId, ...event } = payload
    this.emit({ type: 'stream', event })
  }

  private onState = (
    _event: Electron.IpcMainEvent,
    page: { url: string; title: string; loginRequired: boolean; composerReady: boolean }
  ): void => {
    const phase: DeepSeekStatus['phase'] = page.loginRequired
      ? 'login_required'
      : page.composerReady
        ? 'ready'
        : 'error'
    this.lastState = {
      phase,
      url: page.url,
      externalId: extractConversationId(page.url),
      loginRequired: page.loginRequired,
      composerReady: page.composerReady,
      pageTitle: page.title,
      message: page.loginRequired
        ? '请先在网页面板登录 DeepSeek'
        : page.composerReady
          ? 'DeepSeek 网页已连接'
          : '没有找到输入框，请检查网页状态'
    }
    this.emit({ type: 'state', state: this.lastState })
  }
}
