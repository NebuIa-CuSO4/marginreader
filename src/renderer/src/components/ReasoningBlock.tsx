import { useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { Markdown } from './Markdown'

export function ReasoningBlock({
  text,
  streaming
}: {
  text: string
  streaming: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <div className={`reasoning-block ${open ? 'open' : ''}`}>
      <button
        className="reasoning-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        type="button"
      >
        <Brain size={14} />
        <span>{streaming ? '思考中…' : '深度思考过程'}</span>
        <ChevronDown size={14} className="reasoning-chevron" />
      </button>
      {open && (
        <div className="reasoning-content">
          <Markdown content={text} />
        </div>
      )}
    </div>
  )
}
