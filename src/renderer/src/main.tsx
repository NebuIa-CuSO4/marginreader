import React from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import App from './App'
import { RenderBoundary } from './components/RenderBoundary'
import { InspectorPage } from './InspectorPage'
import './styles.css'

const params = new URLSearchParams(window.location.search)
const inspectorProjectId = params.get('view') === 'inspector' ? params.get('projectId') : null

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RenderBoundary area="app" fallback={(
      <div className="loading-screen" role="alert">
        <strong>界面加载遇到问题</strong>
        <button type="button" className="soft-button" onClick={() => window.location.reload()}>重新加载界面</button>
      </div>
    )}>
      {inspectorProjectId ? <InspectorPage projectId={inspectorProjectId} /> : <App />}
    </RenderBoundary>
  </React.StrictMode>
)
