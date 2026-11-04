import { isValidElement, memo, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import { Check, Copy, Download } from 'lucide-react'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import renderMathInElement from 'katex/contrib/auto-render'
import { normalizeMathMarkdown } from '../../../shared/markdownMath'

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
  return ''
}

function codeLanguage(className: string): string {
  const match = className.match(/language-([\w-]+)/)
  return match?.[1] ?? ''
}

function codeExtension(language: string): string {
  const map: Record<string, string> = {
    python: 'py',
    py: 'py',
    javascript: 'js',
    js: 'js',
    typescript: 'ts',
    ts: 'ts',
    tsx: 'tsx',
    jsx: 'jsx',
    json: 'json',
    html: 'html',
    css: 'css',
    bash: 'sh',
    shell: 'sh',
    sh: 'sh',
    sql: 'sql',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cxx: 'cpp',
    go: 'go',
    rust: 'rs',
    yaml: 'yml',
    yml: 'yml',
    markdown: 'md',
    md: 'md'
  }
  return map[language.toLowerCase()] ?? 'txt'
}

function cleanCode(value: string): string {
  const lines = value.replace(/\r\n/g, '\n').split('\n')
  const label = /^\s*(复制|下载|复制代码|下载代码|Copy|Download)(?:\s+(复制|下载|复制代码|下载代码|Copy|Download))*\s*$/i
  while (lines.length && label.test(lines[0])) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.join('\n')
}

function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const child = Array.isArray(children) ? children[0] : children
  const childProps = isValidElement<{ className?: string; children?: ReactNode }>(child)
    ? child.props
    : null
  const className = childProps?.className ?? ''
  const language = codeLanguage(className)
  const code = cleanCode(nodeText(childProps?.children ?? children))
  const [status, setStatus] = useState<'idle' | 'copied' | 'saved'>('idle')

  async function copy(): Promise<void> {
    try {
      await window.margin.app.copyText(code)
    } catch {
      await navigator.clipboard.writeText(code)
    }
    setStatus('copied')
    window.setTimeout(() => setStatus('idle'), 1600)
  }

  async function download(): Promise<void> {
    const fileName = `code-${Date.now()}.${codeExtension(language)}`
    const saved = await window.margin.app.saveTextFile({ fileName, content: code })
    if (saved) {
      setStatus('saved')
      window.setTimeout(() => setStatus('idle'), 1800)
    }
  }

  return (
    <div className="code-shell">
      <div className="code-bar">
        <span className="code-lang">{language || '代码'}</span>
        <div className="code-actions">
          <button type="button" onClick={() => void copy()} title="复制代码">
            {status === 'copied' ? <Check size={13} /> : <Copy size={13} />}
            {status === 'copied' ? '已复制' : '复制'}
          </button>
          <button type="button" onClick={() => void download()} title="下载代码">
            {status === 'saved' ? <Check size={13} /> : <Download size={13} />}
            {status === 'saved' ? '已保存' : '下载'}
          </button>
        </div>
      </div>
      <pre>
        <code className={className}>{code}</code>
      </pre>
    </div>
  )
}

function MarkdownBase({ content }: { content: string }): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    try {
      renderMathInElement(root, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false }
        ],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
        ignoredClasses: ['katex'],
        throwOnError: false,
        strict: false,
        errorColor: 'currentColor'
      })
    } catch {
      // A single malformed formula must not break the rest of the answer.
    }
  }, [content])

  return (
    <div className="markdown" ref={rootRef}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false, strict: false, errorColor: 'currentColor' }]
        ]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          )
        }}
      >
        {normalizeMathMarkdown(content)}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownBase)
