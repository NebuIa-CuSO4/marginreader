import { app } from 'electron'
import path from 'node:path'

export function getResourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
}

export function getResource(name: string): string {
  return path.join(getResourcesDir(), name)
}

export function getPreload(name: string): string {
  return path.join(__dirname, '../preload', `${name}.js`)
}

export function getRendererFile(name = 'index.html'): string {
  return path.join(__dirname, '../renderer', name)
}

export function getDatabasePath(): string {
  return path.join(app.getPath('userData'), 'margin.db')
}

export function getTempDir(): string {
  return path.join(app.getPath('temp'), 'margin-ocr')
}
