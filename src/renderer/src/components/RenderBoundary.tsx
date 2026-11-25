import { Component, type ReactNode } from 'react'

interface Props {
  area: 'app' | 'markdown'
  fallback: ReactNode
  children: ReactNode
}

export class RenderBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error): void {
    window.margin?.app.reportRendererError?.(this.props.area, error.name)
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
