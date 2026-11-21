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

const CODE_UI_LABEL = /^(复制|下载|复制代码|下载代码|Copy|Download)(?:\s+(复制|下载|复制代码|下载代码|Copy|Download))*$/i

/** Lines that start a Markdown block and must never be treated as bare LaTeX. */
const BLOCK_MARKER = /^(#{1,6}\s|>|\s*[-*+]\s|\s*\d+[.)]\s|\||```|~~~|<|!?\[|>>|\$\$)/

/** Environments that are valid inside [ ... ] (already in display math). */
const MATH_ENV = /^\s*\\(?:begin|end)\{(?:matrix|bmatrix|pmatrix|vmatrix|Vmatrix|smallmatrix|cases|array|aligned|gathered|split|align|alignedat|dcases|rcases)(?:\*)?\}/

/** Prose, list, table or code lines are never converted into display math. */
function isProseLine(trimmed: string): boolean {
  if (BLOCK_MARKER.test(trimmed)) return true
  if (/[\u3400-\u9fff]/.test(trimmed)) return true
  return false
}

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
  // Protect inline code spans, fences and already-written $$...$$ math so no
  // delimiter rewriting can ever corrupt them.
  const tokens: string[] = []
  const protect = (value: string): string => {
    tokens.push(value)
    return `\u0000${tokens.length - 1}\u0000`
  }
  let text = markdown
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (match) => protect(match))
    .replace(/`[^`\n]*`/g, (match) => protect(match))
    .replace(/\$\$[\s\S]*?\$\$/g, (match) => protect(match))

  text = stripCodeToolbarLabels(text)
  // Some copied answers contain double-escaped delimiters (\\( ... \\)).
  text = text.replace(/\\{2,}(?=[()[\]])/g, '\\')
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `\n$$\n${body.trim()}\n$$\n`)
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (match, body: string) => `$${body.trim()}$`)
  text = text.replace(
    /\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g,
    (match, body: string) => `\n$$\n${body.trim()}\n$$\n`
  )
  // Convert bare LaTeX lines before rewriting environments, otherwise an
  // alignment block would be mistaken for an escaped \\[ delimiter.
  const protectedNow = text.split(/(\u0000\d+\u0000)/)
  text = protectedNow
    .map((part) => (/^\u0000\d+\u0000$/.test(part) ? part : wrapBareLatexLinesSafe(part)))
    .join('')

  text = text
    .replace(/\\begin\{(align|align\*|eqnarray|eqnarray\*)\}/g, '\\begin{aligned}')
    .replace(/\\end\{(align|align\*|eqnarray|eqnarray\*)\}/g, '\\end{aligned}')
    .replace(/\\begin\{(gather|gather\*)\}/g, '\\begin{gathered}')
    .replace(/\\end\{(gather|gather\*)\}/g, '\\end{gathered}')

  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? '')
}

function wrapBareLatexLinesSafe(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let inDisplayMath = false
  let mathDepth = 0
  for (const line of lines) {
    const trimmed = line.trim()
    const displayTokens = trimmed.match(/\$\$/g)?.length ?? 0
    if (displayTokens > 0) {
      if (displayTokens % 2 === 1) inDisplayMath = !inDisplayMath
      out.push(line)
      continue
    }
    if (MATH_ENV.test(trimmed)) {
      // Environments such as \begin{aligned} only ever live inside a math block.
      if (/\\begin\{/.test(trimmed)) mathDepth += 1
      if (/\\end\{/.test(trimmed)) mathDepth = Math.max(0, mathDepth - 1)
      continue
    }
    if (
      inDisplayMath ||
      mathDepth > 0 ||
      !trimmed ||
      trimmed.startsWith('$') ||
      isProseLine(trimmed) ||
      !looksLikeBareLatex(trimmed)
    ) {
      out.push(line)
      continue
    }
    const indent = line.slice(0, line.length - line.trimStart().length)
    out.push(
      `${indent}$$`,
      `${indent}${repairMalformedLatex(stripStrayDelimiters(trimmed))}`,
      `${indent}$$`
    )
  }
  return out.join('\n')
}
