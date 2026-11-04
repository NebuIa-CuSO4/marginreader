const CODE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g
const LATEX_COMMAND = /\\[a-zA-Z]+|\\[|]/g

function repairMalformedLatex(value: string): string {
  // When DeepSeek's raw text loses the asterisks in (f^*)^*(y), Markdown
  // emphasis can turn it into (f^)^(y). Restore the common conjugation form
  // instead of letting KaTeX render a red error.
  return value
    .replace(/\^\s*\)/g, '^{*})')
    .replace(/\^\s*\(/g, '^{*}(')
    .replace(/\^\s*\]/g, '^{*}]')
    .replace(/\^\s*$/gm, '^{*}')
    .replace(/\^\s*([,.;:，。；：])/g, '^{*}$1')
}

function stripStrayDelimiters(value: string): string {
  let text = value.trim()
  text = text.replace(/^&\s*/, '').trim()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1).trim()
  if (/\\right\s*\]$/.test(text)) return text
  text = text.replace(/^\\?\[\s*/, '').replace(/\s*\\?\]$/, '').trim()
  return text
}

function looksLikeBareLatex(value: string): boolean {
  const hadAlignment = /^&/.test(value.trim())
  const text = stripStrayDelimiters(value)
  if (!text || text.includes('$')) return false
  if (/^\\(?:documentclass|usepackage|newcommand|renewcommand|def|let|input|include)\b/.test(text)) {
    return false
  }

  const commands = text.match(LATEX_COMMAND)?.length ?? 0
  const startsWithCommand =
    /^\\[a-zA-Z]+/.test(text) || /^\\begin\{/.test(text) || /^\\[|]/.test(text)
  // A continuation row often starts with =, <, >, +, - or ( because the left
  // side was on a previous visual line, or with a bare command such as \frac.
  const startsWithContinuation = /^[=<>+\-(]/.test(text)
  const hasScript = /[\^_]/.test(text)
  const hasRelation = /[=<>]/.test(text) || /\\(?:ge|le|neq|approx|equiv|implies|iff|to|rightarrow|leftarrow|mapsto|propto|sim|cong|ll|gg)(?![a-zA-Z])/.test(text)
  const hasBraces = /[{}]/.test(text)
  const hasCjk = /[\u3400-\u9fff]/.test(text)
  const mathOnly = /^[A-Za-z0-9\s+\-*/=<>^_()[\]{}.,:|\\]+$/.test(text)

  if (hadAlignment) {
    return commands > 0 || hasScript || hasBraces || hasRelation
  }
  if (startsWithContinuation) {
    return commands > 0 || hasScript || hasBraces || /[=<>]/.test(text)
  }
  if (startsWithCommand) {
    return commands > 0 && (hasRelation || hasScript || hasBraces || commands >= 2 || text.length <= 12)
  }
  if (hasCjk) return false
  if (!mathOnly) return false
  if (/^\|/.test(text) && hasScript) return true
  const hasProseWord = /[A-Za-z]{3,}/.test(text.replace(LATEX_COMMAND, ''))
  if (commands > 0 && !hasProseWord) return true
  // Plain mathematical lines without any LaTeX command, e.g. "x = y^2".
  // Reject lines containing ordinary words such as "The value = 3".
  return hasRelation && !hasProseWord && (hasScript || /[0-9]/.test(text))
}

function wrapBareLatexLines(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let inDisplayMath = false
  for (const line of lines) {
    const trimmed = line.trim()
    const displayTokens = trimmed.match(/\$\$/g)?.length ?? 0
    if (displayTokens > 0) {
      if (displayTokens % 2 === 1) inDisplayMath = !inDisplayMath
      out.push(line)
      continue
    }
    if (inDisplayMath || !trimmed || trimmed.startsWith('$')) {
      out.push(line)
      continue
    }
    if (looksLikeBareLatex(trimmed)) {
      out.push('$$', repairMalformedLatex(stripStrayDelimiters(trimmed)), '$$')
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

const CODE_UI_LABEL = /^(复制|下载|复制代码|下载代码|Copy|Download)(?:\s+(复制|下载|复制代码|下载代码|Copy|Download))*$/i

function stripCodeToolbarLabels(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !CODE_UI_LABEL.test(line.trim()))
    .join('\n')
}

/**
 * DeepSeek often emits LaTeX with \( \) and \[ \] delimiters.
 * remark-math understands $ / $$, so normalize outside code fences.
 */
export function normalizeMathMarkdown(markdown: string): string {
  const parts = markdown.split(CODE_SPLIT)
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part
      let text = stripCodeToolbarLabels(part)
      // Some copied answers contain double-escaped delimiters (\\( ... \\)).
      text = text.replace(/\\{2,}(?=[()[\]])/g, '\\')
      text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body.trim()}$`)
      text = text.replace(
        /\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g,
        (_match, body: string) => `\n$$\n${body.trim()}\n$$\n`
      )
      text = text
        .replace(/\\begin\{(align|align\*|eqnarray|eqnarray\*)\}/g, '\\begin{aligned}')
        .replace(/\\end\{(align|align\*|eqnarray|eqnarray\*)\}/g, '\\end{aligned}')
        .replace(/\\begin\{(gather|gather\*)\}/g, '\\begin{gathered}')
        .replace(/\\end\{(gather|gather\*)\}/g, '\\end{gathered}')
      return wrapBareLatexLines(text)
    })
    .join('')
}
