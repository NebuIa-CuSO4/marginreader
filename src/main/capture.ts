import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CaptureResult, Settings } from '../shared/types'
import type { WindowManager } from './windowManager'
import { getPreload, getRendererFile, getResource, getTempDir } from './paths'

const execFileAsync = promisify(execFile)

function toUploadDataUrl(image: Electron.NativeImage): string {
  const size = image.getSize()
  const maxEdge = 1600
  let prepared = image
  if (size.width > maxEdge || size.height > maxEdge) {
    const scale = Math.min(maxEdge / size.width, maxEdge / size.height)
    prepared = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good'
    })
  }
  return `data:image/jpeg;base64,${prepared.toJPEG(84).toString('base64')}`
}

interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

interface OcrPayload {
  text?: string
  lineCount?: number
  language?: string
  error?: string
}

export interface ScreenContext {
  text: string
  imageDataUrl: string
  lineCount: number
  width: number
  height: number
  error?: string
}

export class CaptureService {
  private overlay: BrowserWindow | null = null
  private display: Electron.Display | null = null
  private busy = false

  constructor(
    private readonly windows: WindowManager,
    private readonly getSettings: () => Settings,
    private readonly onResult: (result: CaptureResult) => void,
    private readonly onBeforeCapture: () => void
  ) {
    ipcMain.on('capture:commit', (_event, rect: SelectionRect) => {
      void this.finish(rect)
    })
    ipcMain.on('capture:cancel', () => this.cancel())
  }

  async start(): Promise<void> {
    if (this.busy || this.overlay) return
    this.busy = true
    this.onBeforeCapture()
    this.windows.hideForCapture()
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    this.display = display
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
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
        preload: getPreload('overlay'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    this.overlay = overlay
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setIgnoreMouseEvents(false)
    let shown = false
    const reveal = (): void => {
      if (shown || overlay.isDestroyed()) return
      shown = true
      overlay.show()
      overlay.focus()
    }
    overlay.once('ready-to-show', reveal)
    overlay.webContents.once('did-finish-load', () => setTimeout(reveal, 30))
    overlay.on('closed', () => {
      if (this.overlay === overlay) this.overlay = null
      this.busy = false
      this.windows.restoreAfterCapture()
    })
    try {
      if (process.env.ELECTRON_RENDERER_URL) {
        await overlay.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay.html`)
      } else {
        await overlay.loadFile(path.join(path.dirname(getRendererFile()), 'overlay.html'))
      }
    } catch (error) {
      this.closeOverlay()
      this.windows.restoreAfterCapture()
      this.busy = false
      throw error
    }
  }

  async captureForContext(): Promise<ScreenContext> {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const scale = display.scaleFactor || 1
    const maxWidth = Math.min(Math.round(display.bounds.width * scale), 3000)
    const maxHeight = Math.min(Math.round(display.bounds.height * scale), 3000)
    let restored = false
    try {
      // Hide the rail briefly so the area it covers is captured from the app
      // underneath, then restore immediately after the frame is grabbed.
      this.windows.hideForCapture()
      await new Promise((resolve) => setTimeout(resolve, 120))
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: maxWidth, height: maxHeight }
      })
      this.windows.restoreAfterCapture()
      restored = true
      const source =
        sources.find((item) => String(item.display_id) === String(display.id)) ??
        sources.find((item) => item.id.startsWith('screen:')) ??
        sources[0]
      if (!source || source.thumbnail.isEmpty()) {
        throw new Error('无法读取当前屏幕')
      }
      const image = source.thumbnail
      const imageSize = image.getSize()

      const tempDir = getTempDir()
      await fs.mkdir(tempDir, { recursive: true })
      const filePath = path.join(tempDir, `${randomUUID()}.png`)
      try {
        await fs.writeFile(filePath, image.toPNG())
        const payload = await this.recognize(filePath, this.getSettings().ocrLanguage)
        return {
          text: (payload.text ?? '').slice(0, 12000),
          imageDataUrl: toUploadDataUrl(image),
          lineCount: payload.lineCount ?? 0,
          width: imageSize.width,
          height: imageSize.height,
          error: payload.error
        }
      } finally {
        await fs.rm(filePath, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      return {
        text: '',
        imageDataUrl: '',
        lineCount: 0,
        width: 0,
        height: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (!restored) this.windows.restoreAfterCapture()
    }
  }

  private cancel(): void {
    this.closeOverlay()
    this.windows.restoreAfterCapture()
    this.busy = false
  }

  private closeOverlay(): void {
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.close()
    this.overlay = null
  }

  private async finish(rect: SelectionRect): Promise<void> {
    const display = this.display
    if (!display) return
    this.closeOverlay()
    try {
      if (!rect || rect.width < 6 || rect.height < 6) {
        this.onResult({ text: '', lineCount: 0, width: 0, height: 0, error: '选择区域太小' })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 180))
      const scale = display.scaleFactor || 1
      const maxWidth = Math.min(Math.round(display.bounds.width * scale), 3600)
      const maxHeight = Math.min(Math.round(display.bounds.height * scale), 3600)
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: maxWidth, height: maxHeight }
      })
      const source =
        sources.find((item) => String(item.display_id) === String(display.id)) ??
        sources.find((item) => item.id.startsWith('screen:')) ??
        sources[0]
      if (!source || source.thumbnail.isEmpty()) {
        throw new Error('无法捕获屏幕画面，可能是权限或受保护内容。')
      }
      const image = source.thumbnail
      const size = image.getSize()
      const scaleX = size.width / display.bounds.width
      const scaleY = size.height / display.bounds.height
      const cropX = Math.max(0, Math.min(size.width - 2, Math.round(rect.x * scaleX)))
      const cropY = Math.max(0, Math.min(size.height - 2, Math.round(rect.y * scaleY)))
      const cropW = Math.max(2, Math.min(size.width - cropX, Math.round(rect.width * scaleX)))
      const cropH = Math.max(2, Math.min(size.height - cropY, Math.round(rect.height * scaleY)))
      const cropped = image.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
      // Manual screenshots now go to the web conversation as an image.
      // No OCR text is generated or inserted into the composer.
      this.onResult({
        text: '',
        imageDataUrl: toUploadDataUrl(cropped),
        lineCount: 0,
        width: cropW,
        height: cropH
      })
    } catch (error) {
      this.onResult({
        text: '',
        lineCount: 0,
        width: 0,
        height: 0,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      this.windows.restoreAfterCapture()
      this.busy = false
      this.display = null
    }
  }

  private async recognize(filePath: string, language: string): Promise<OcrPayload> {
    const script = getResource('ocr.ps1')
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-ImagePath',
          filePath,
          '-Language',
          language || 'auto'
        ],
        {
          windowsHide: true,
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8'
        }
      )
      const cleaned = stdout.replace(/^\uFEFF/, '').trim()
      const start = cleaned.indexOf('{')
      const end = cleaned.lastIndexOf('}')
      if (start < 0 || end < start) throw new Error('OCR 没有返回有效结果。')
      return JSON.parse(cleaned.slice(start, end + 1)) as OcrPayload
    } catch (error) {
      const candidate = error as { stdout?: string; message?: string }
      if (candidate.stdout) {
        try {
          const cleaned = candidate.stdout.replace(/^\uFEFF/, '').trim()
          const start = cleaned.indexOf('{')
          const end = cleaned.lastIndexOf('}')
          if (start >= 0 && end >= start) {
            const parsed = JSON.parse(cleaned.slice(start, end + 1)) as OcrPayload
            if (parsed.error) return parsed
          }
        } catch {
          // fall through
        }
      }
      return { text: '', lineCount: 0, error: candidate.message ?? 'OCR 失败' }
    }
  }
}
