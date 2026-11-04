import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('overlayApi', {
  ready: (): void => ipcRenderer.send('capture:ready'),
  commit: (rect: { x: number; y: number; width: number; height: number }): void =>
    ipcRenderer.send('capture:commit', rect),
  cancel: (): void => ipcRenderer.send('capture:cancel')
})
