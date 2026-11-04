import type { MarginApi } from '../../shared/api'

declare global {
  interface Window {
    margin: MarginApi
    overlayApi?: {
      ready: () => void
      commit: (rect: { x: number; y: number; width: number; height: number }) => void
      cancel: () => void
    }
    toolbarApi?: {
      action: (action: 'translate' | 'explain' | 'save') => void
      close: () => void
    }
  }
}

export {}
