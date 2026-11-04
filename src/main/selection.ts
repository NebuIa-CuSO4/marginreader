import { BrowserWindow, clipboard, Notification, screen, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { SelectionActionKind } from '../shared/types'
import { getPreload, getRendererFile, getResource } from './paths'

const execFileAsync = promisify(execFile)

export class SelectionService {
  private toolbar: BrowserWindow | null = null
  private busy = false

  constructor(private readonly onAction: (action: SelectionActionKind, text: string) => void) {}

  async captureSelection(): Promise<void> {
    if (this.busy) return
    this.busy = true
    const snapshot = await this.snapshotClipboard()
    try {
      const selected = (await this.readViaUiAutomation()) || (await this.readViaClipboard())
      if (!selected) {
        shell.beep()
        new Notification({
          title: '页边',
          body: '没有读取到选中文字。请先选中一段文字，再按快捷键。'
        }).show()
        return
      }
      this.showToolbar(selected.slice(0, 12000))
    } catch (error) {
      shell.beep()
      new Notification({
        title: '页边',
        body: `读取选中文字失败：${error instanceof Error ? error.message : String(error)}`
      }).show()
    } finally {
      await this.restoreClipboard(snapshot)
      this.busy = false
    }
  }

  private async readViaUiAutomation(): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-ExecutionPolicy',
          'Bypass',
          '-OutputFormat',
          'Text',
          '-File',
          getResource('read-selection.ps1')
        ],
        { windowsHide: true, timeout: 3500, encoding: 'utf8' }
      )
      return stdout.replace(/^\uFEFF/, '').trim()
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout
      return stdout ? stdout.replace(/^\uFEFF/, '').trim() : ''
    }
  }

  private async readViaClipboard(): Promise<string> {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        getResource('copy-selection.ps1')
      ],
      { windowsHide: true, timeout: 5000, encoding: 'utf8' }
    )
    await new Promise((resolve) => setTimeout(resolve, 260))
    return (await clipboard.readText()).trim()
  }

  hide(): void {
    if (this.toolbar && !this.toolbar.isDestroyed()) this.toolbar.hide()
  }

  destroy(): void {
    if (this.toolbar && !this.toolbar.isDestroyed()) this.toolbar.destroy()
    this.toolbar = null
  }

  private async snapshotClipboard(): Promise<Electron.ClipboardItem[]> {
    try {
      return await clipboard.read()
    } catch {
      return []
    }
  }

  private async restoreClipboard(snapshot: Electron.ClipboardItem[]): Promise<void> {
    try {
      if (snapshot.length) await clipboard.write(snapshot)
      else clipboard.clear()
    } catch {
      // Clipboard restoration is best effort; selection text is already captured.
    }
  }

  private showToolbar(text: string): void {
    this.hide()
    if (this.toolbar && !this.toolbar.isDestroyed()) this.toolbar.destroy()
    const cursor = screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(cursor).workArea
    const width = 302
    const height = 54
    const x = Math.max(area.x + 8, Math.min(cursor.x + 12, area.x + area.width - width - 8))
    const y = Math.max(area.y + 8, Math.min(cursor.y + 18, area.y + area.height - height - 8))
    const toolbar = new BrowserWindow({
      width,
      height,
      x,
      y,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: {
        preload: getPreload('toolbar'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    this.toolbar = toolbar
    toolbar.setAlwaysOnTop(true, 'pop-up-menu')
    toolbar.setIgnoreMouseEvents(false)
    let shown = false
    const reveal = (): void => {
      if (shown || toolbar.isDestroyed()) return
      shown = true
      toolbar.webContents.send('toolbar:selection', text)
      toolbar.show()
      toolbar.focus()
    }
    toolbar.once('ready-to-show', reveal)
    toolbar.webContents.once('did-finish-load', () => setTimeout(reveal, 30))
    toolbar.on('blur', () => {
      setTimeout(() => {
        if (this.toolbar === toolbar && !toolbar.isDestroyed() && !toolbar.isFocused()) this.hide()
      }, 140)
    })
    toolbar.on('closed', () => {
      if (this.toolbar === toolbar) this.toolbar = null
    })
    const url = process.env.ELECTRON_RENDERER_URL
      ? `${process.env.ELECTRON_RENDERER_URL}/toolbar.html`
      : path.join(path.dirname(getRendererFile()), 'toolbar.html')
    if (process.env.ELECTRON_RENDERER_URL) void toolbar.loadURL(url)
    else void toolbar.loadFile(url)
  }
}
