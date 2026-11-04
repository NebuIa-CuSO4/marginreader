import { contextBridge, ipcRenderer } from 'electron'

let selectedText = ''

ipcRenderer.on('toolbar:selection', (_event, text: string) => {
  selectedText = text
  window.dispatchEvent(new CustomEvent('toolbar-selection', { detail: text }))
})

contextBridge.exposeInMainWorld('toolbarApi', {
  action: (action: 'translate' | 'explain' | 'save'): void => {
    ipcRenderer.send('selection:action', { action, text: selectedText })
  },
  close: (): void => ipcRenderer.send('toolbar:close')
})
