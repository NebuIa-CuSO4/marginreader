import { BrowserWindow, screen, shell } from 'electron'
import { getPreload, getRendererFile } from './paths'
import type { DockSide, Settings, WindowState } from '../shared/types'

const RIGHT_WIDTH = 438
const RIGHT_HEIGHT = 920
const TOP_WIDTH = 820
const TOP_HEIGHT = 500
const RAIL = 16

export class WindowManager {
  private mainWindow: BrowserWindow | null = null
  private collapsed = false
  private side: DockSide = 'right'
  private pinned = false
  private autoHide = true
  private hiddenForCapture = false
  private displayId = screen.getPrimaryDisplay().id

  constructor() {
    const cursor = screen.getCursorScreenPoint()
    this.displayId = screen.getDisplayNearestPoint(cursor).id
    screen.on('display-metrics-changed', () => this.reposition())
    screen.on('display-added', () => this.reposition())
    screen.on('display-removed', () => this.reposition())
  }

  get window(): BrowserWindow | null {
    return this.mainWindow
  }

  create(settings: Settings): BrowserWindow {
    this.side = settings.dockSide
    this.pinned = settings.pinned
    this.autoHide = settings.autoHide
    this.collapsed = false

    const bounds = this.expandedBounds()
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#f7f4ee',
      hasShadow: true,
      resizable: true,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: '页边 Margin',
      webPreferences: {
        preload: getPreload('index'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })

    this.mainWindow = win
    win.setMenuBarVisibility(false)
    win.removeMenu()
    win.setAlwaysOnTop(true, 'floating')
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    } catch {
      // Windows may ignore this.
    }

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void win.loadFile(getRendererFile())
    }

    win.once('ready-to-show', () => {
      win.showInactive()
      this.sendState()
    })
    win.webContents.on('did-finish-load', () => {
      this.sendState()
    })
    win.on('closed', () => {
      this.mainWindow = null
    })
    win.on('resize', () => this.sendState())
    return win
  }

  getState(): WindowState {
    return { collapsed: this.collapsed, side: this.side, pinned: this.pinned }
  }

  applySettings(settings: Settings): void {
    const sideChanged = this.side !== settings.dockSide
    this.side = settings.dockSide
    this.pinned = settings.pinned
    this.autoHide = settings.autoHide
    if (sideChanged) {
      this.collapsed = false
      this.reposition()
    }
    if (this.pinned && this.collapsed) {
      this.expand(false)
    }
    this.sendState()
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned
    if (pinned && this.collapsed) this.expand(false)
    this.sendState()
  }

  setSide(side: DockSide): void {
    this.side = side
    this.collapsed = false
    this.reposition()
    this.sendState()
  }

  expand(focus = false): void {
    if (!this.mainWindow) return
    this.collapsed = false
    this.mainWindow.setResizable(true)
    this.mainWindow.setMinimumSize(320, 320)
    this.mainWindow.setBounds(this.expandedBounds(), false)
    if (focus) {
      this.mainWindow.show()
      this.mainWindow.focus()
    } else {
      this.mainWindow.showInactive()
    }
    this.sendState()
  }

  collapse(): void {
    if (!this.mainWindow || this.pinned) return
    this.collapsed = true
    this.mainWindow.setMinimumSize(1, 1)
    this.mainWindow.setResizable(false)
    this.mainWindow.setBounds(this.collapsedBounds(), false)
    this.mainWindow.showInactive()
    this.sendState()
  }

  toggle(focus = true): void {
    if (this.collapsed) this.expand(focus)
    else this.collapse()
  }

  hideForCapture(): void {
    if (!this.mainWindow) return
    this.hiddenForCapture = this.mainWindow.isVisible()
    this.mainWindow.hide()
  }

  restoreAfterCapture(): void {
    if (!this.mainWindow) return
    if (this.hiddenForCapture) {
      this.mainWindow.showInactive()
      this.hiddenForCapture = false
    }
  }

  focus(): void {
    if (!this.mainWindow) return
    if (this.collapsed) this.expand(true)
    else {
      this.mainWindow.show()
      this.mainWindow.focus()
    }
  }

  private sendState(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send('window:state-changed', this.getState())
  }

  private reposition(): void {
    if (!this.mainWindow) return
    this.mainWindow.setBounds(this.collapsed ? this.collapsedBounds() : this.expandedBounds(), false)
  }

  private workArea(): Electron.Rectangle {
    const display =
      screen.getAllDisplays().find((item) => item.id === this.displayId) ?? screen.getPrimaryDisplay()
    return display.workArea
  }

  private expandedBounds(): Electron.Rectangle {
    const area = this.workArea()
    if (this.side === 'top') {
      const width = Math.min(TOP_WIDTH, Math.max(520, area.width - 40))
      const height = Math.min(TOP_HEIGHT, Math.max(340, area.height - 40))
      return {
        x: Math.round(area.x + (area.width - width) / 2),
        y: area.y + 10,
        width,
        height
      }
    }
    const height = Math.min(RIGHT_HEIGHT, Math.max(480, area.height - 24))
    return {
      x: area.x + area.width - RIGHT_WIDTH,
      y: area.y + Math.max(8, Math.round((area.height - height) / 2)),
      width: RIGHT_WIDTH,
      height
    }
  }

  private collapsedBounds(): Electron.Rectangle {
    const area = this.workArea()
    if (this.side === 'top') {
      return {
        x: Math.round(area.x + (area.width - 260) / 2),
        y: area.y,
        width: 260,
        height: RAIL
      }
    }
    return {
      x: area.x + area.width - RAIL,
      y: area.y + Math.round((area.height - 240) / 2),
      width: RAIL,
      height: 240
    }
  }
}
