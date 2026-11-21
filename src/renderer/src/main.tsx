import React from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import App from './App'
import { InspectorPage } from './InspectorPage'
import './styles.css'

const params = new URLSearchParams(window.location.search)
const inspectorProjectId = params.get('view') === 'inspector' ? params.get('projectId') : null

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {inspectorProjectId ? <InspectorPage projectId={inspectorProjectId} /> : <App />}
  </React.StrictMode>
)
