import { ipcRenderer } from 'electron'

interface Command {
  id: string
  type: string
  payload?: Record<string, unknown>
}

interface BridgeError {
  code: string
  message: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function visible(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false
  const rect = el.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  const style = getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
}

function hiddenTextElement(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  // aria-hidden only hides content from accessibility APIs; it does not hide
  // it visually. KaTeX/DeepSeek wrappers use it around visible matrices.
  if (el.hasAttribute('hidden')) return true
  const style = getComputedStyle(el)
  return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0'
}

function composerCandidates(): HTMLElement[] {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'
    )
  ).filter(visible)
  return nodes.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
}

function findComposer(): HTMLElement | null {
  return composerCandidates()[0] ?? null
}

function composerText(el: HTMLElement | null): string {
  if (!el) return ''
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value
  return el.innerText ?? el.textContent ?? ''
}

function labelOf(el: HTMLElement): string {
  return [
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
    el.getAttribute('data-testid') ?? '',
    el.innerText ?? ''
  ]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function findSendButton(): HTMLElement | null {
  const composer = findComposer()
  const composerRect = composer?.getBoundingClientRect()
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, [role="button"], div[class*="send"], div[class*="button"]')
  ).filter(visible)
  let best: { el: HTMLElement; score: number } | null = null
  for (const el of candidates) {
    if (
      el instanceof HTMLButtonElement &&
      (el.disabled || el.getAttribute('aria-disabled') === 'true')
    ) {
      continue
    }
    if (el.getAttribute('aria-disabled') === 'true') continue
    if (el.closest('[contenteditable="true"]')) continue
    const label = labelOf(el)
    const rect = el.getBoundingClientRect()
    let score = 0
    if (/发送|send/i.test(label)) score += 12
    if (/停止|stop/i.test(label)) score -= 20
    if (/附件|attach|upload|上传|文件|图片|image/i.test(label)) score -= 12
    if (el instanceof HTMLButtonElement && el.type === 'submit') score += 4
    if (composerRect) {
      const nearX = rect.left > composerRect.right - 140 && rect.left < composerRect.right + 80
      const nearY = rect.bottom > composerRect.bottom - 100 && rect.top < composerRect.bottom + 100
      if (nearX && nearY) score += 6
      if (rect.left > composerRect.right - 80 && rect.top > composerRect.top) score += 3
    }
    if (rect.width <= 64 && rect.height <= 64) score += 1
    if (score > 0 && (!best || score > best.score)) best = { el, score }
  }
  return best?.el ?? null
}

function findStopButton(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, [role="button"], div[class*="button"]')
  ).filter(visible)
  for (const el of candidates) {
    const label = labelOf(el)
    if (/停止|stop/i.test(label)) return el
  }
  return null
}

function setComposerText(el: HTMLElement, text: string): void {
  el.focus()
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter?.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  try {
    document.execCommand('insertText', false, text)
  } catch {
    el.textContent = text
  }
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
  )
}

function pressEnter(el: HTMLElement): void {
  el.focus()
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  }
  el.dispatchEvent(new KeyboardEvent('keydown', init))
  el.dispatchEvent(new KeyboardEvent('keypress', init))
  el.dispatchEvent(new KeyboardEvent('keyup', init))
}

let sidebarCache: { value: HTMLElement | null; at: number } | null = null

function findSidebar(): HTMLElement | null {
  if (sidebarCache && Date.now() - sidebarCache.at < 1200) return sidebarCache.value
  const result = findSidebarUncached()
  sidebarCache = { value: result, at: Date.now() }
  return result
}

function findSidebarUncached(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'aside, nav, [role="complementary"], [class*="sidebar"], [class*="side-bar"], [class*="sider"], [class*="drawer"], [class*="history"], [class*="conversation-list"], [class*="chat-list"]'
    )
  ).filter(visible)
  for (const el of candidates) {
    const rect = el.getBoundingClientRect()
    if (
      rect.height > window.innerHeight * 0.45 &&
      rect.width < window.innerWidth * 0.45 &&
      rect.left < window.innerWidth * 0.35
    ) {
      return el
    }
  }

  // DeepSeek may use hashed class names. Fall back to a geometric left column
  // with multiple controls or history-like text.
  const columns = Array.from(document.querySelectorAll<HTMLElement>('div, nav, aside')).filter(
    visible
  )
  for (const el of columns) {
    const rect = el.getBoundingClientRect()
    if (
      rect.height > window.innerHeight * 0.55 &&
      rect.width >= 48 &&
      rect.width < window.innerWidth * 0.42 &&
      rect.left < window.innerWidth * 0.35
    ) {
      const controls = el.querySelectorAll('a, button, [role="button"]').length
      const text = (el.innerText ?? '').slice(0, 500)
      if (controls >= 2 || /会话|历史|conversation|history|chat list/i.test(text)) {
        return el
      }
    }
  }
  return null
}

let chatRootCache: { value: HTMLElement | null; at: number } | null = null

function findChatRoot(): HTMLElement | null {
  if (
    chatRootCache &&
    Date.now() - chatRootCache.at < 1200 &&
    (!chatRootCache.value || chatRootCache.value.isConnected)
  ) {
    return chatRootCache.value
  }
  const result = findChatRootUncached()
  chatRootCache = { value: result, at: Date.now() }
  return result
}

function findChatRootUncached(): HTMLElement | null {
  const composer = findComposer()
  if (!composer) return null
  const sidebar = findSidebar()
  const explicit = composer.closest('main, [role="main"]')
  if (explicit instanceof HTMLElement && !(sidebar && explicit.contains(sidebar))) {
    return explicit
  }

  let node: HTMLElement | null = composer.parentElement
  let best: HTMLElement | null = null
  while (node && node !== document.body) {
    const rect = node.getBoundingClientRect()
    if (sidebar && node.contains(sidebar)) break
    if (rect.width >= window.innerWidth * 0.4 && rect.height >= window.innerHeight * 0.4) {
      best = node
    }
    node = node.parentElement
  }
  if (best) return best

  const fallback = composer.closest('[class*="chat"], [class*="conversation"], [class*="message"]')
  return fallback instanceof HTMLElement ? fallback : null
}

function katexSource(el: Element): { tex: string; display: boolean } | null {
  const annotation = el.querySelector('annotation[encoding="application/x-tex"]')
  const math = el.querySelector('math')
  const tex =
    annotation?.textContent?.trim() ||
    math?.getAttribute('alttext')?.trim() ||
    el.getAttribute('data-tex')?.trim() ||
    el.getAttribute('data-latex')?.trim()
  if (!tex) return null
  return { tex, display: Boolean(el.closest('.katex-display')) }
}

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'blockquote',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
])

/**
 * DeepSeek renders formulas with KaTeX. innerText exposes the hidden MathML
 * accessibility tree (𝑢, 𝑚, 𝜆 ...), which looks like garbled Unicode. Rebuild
 * the text from the original TeX annotation instead.
 */
function extractTextWithMath(root: Node, skip?: Set<Element>): string {
  const parts: string[] = []
  const append = (value: string): void => {
    if (value) parts.push(value)
  }
  const children = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  const walk = (node: Node): void => {
    if (skip && node instanceof Element && skip.has(node)) return
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.nodeValue ?? '')
      return
    }
    if (!(node instanceof Element)) return
    const tag = node.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return
    if (tag === 'math') {
      const annotation = node.querySelector('annotation[encoding="application/x-tex"]')
      const tex =
        annotation?.textContent?.trim() ||
        node.getAttribute('alttext')?.trim() ||
        ''
      if (tex) {
        const display = node.getAttribute('display') === 'block'
        append(display ? `\n$$\n${tex}\n$$\n` : `$${tex}$`)
        return
      }
    }
    // DeepSeek keeps invisible citation/index nodes in the answer DOM. They
    // were leaking into the visible answer as "-1", "-23" lines.
    if (hiddenTextElement(node)) return
    if (node.classList.contains('katex')) {
      const math = katexSource(node)
      if (math) {
        append(math.display ? `\n$$\n${math.tex}\n$$\n` : `$${math.tex}$`)
        return
      }
    }
    if (node.classList.contains('katex-mathml') || node.classList.contains('katex-html')) {
      return
    }
    if (tag === 'img') {
      const alt = (node.getAttribute('alt') ?? '').trim()
      if (alt) append(alt)
      return
    }
    if (tag === 'br') {
      append('\n')
      return
    }
    if (tag === 'div' || tag === 'span' || tag === 'p') {
      const text = ((node as HTMLElement).innerText ?? '').trim()
      const label = (node.getAttribute('aria-label') ?? node.getAttribute('title') ?? '').trim()
      if (!text && label && label.length <= 200 && !/^[-\d\s]+$/.test(label)) {
        append(label)
        return
      }
      if (text && text.length <= 120) {
        const style = getComputedStyle(node)
        const size = Number.parseFloat(style.fontSize)
        const weight = Number.parseInt(style.fontWeight, 10) || 400
        if (size >= 20 && weight >= 600) {
          append(`\n${size >= 28 ? '#' : '##'} `)
          children(node)
          append('\n')
          return
        }
      }
    }
    if (tag === 'pre') {
      append(`\n\`\`\`\n${node.textContent ?? ''}\n\`\`\`\n`)
      return
    }
    if (tag === 'strong' || tag === 'b') {
      append('**')
      children(node)
      append('**')
      return
    }
    if (tag === 'em' || tag === 'i') {
      append('*')
      children(node)
      append('*')
      return
    }
    if (tag === 'code') {
      append('`')
      append(node.textContent ?? '')
      append('`')
      return
    }
    if (tag === 'a') {
      append('[')
      children(node)
      const href = node.getAttribute('href') ?? ''
      append(href ? `](${href})` : ']')
      return
    }
    if (/^h[1-6]$/.test(tag)) {
      append(`\n${'#'.repeat(Number(tag[1]))} `)
      children(node)
      append('\n')
      return
    }
    if (tag === 'li') {
      append('\n- ')
      children(node)
      append('\n')
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      append('\n')
      children(node)
      append('\n')
      return
    }
    if (tag === 'blockquote') {
      append('\n> ')
      children(node)
      append('\n')
      return
    }
    const block = BLOCK_TAGS.has(tag)
    if (block) append('\n')
    children(node)
    if (block) append('\n')
  }
  walk(root)
  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    // The serializer adds "\n- " for a list item, then the child <p> adds
    // another newline. Join the bullet to its first text line.
    .replace(/(^|\n)-\s*\n+/g, '$1- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const REASONING_SELECTOR =
  '[class*="think"], [class*="reason"], [class*="cot"], [data-testid*="think"], [data-testid*="reason"]'
const THINKING_HEADER = /^(已深度思考|深度思考|思考中|正在思考|Thinking|Reasoning|Thought for|Thought process)/i
let reasoningCache: { roots: HTMLElement[]; at: number } | null = null

function findReasoningRoots(): HTMLElement[] {
  if (reasoningCache && Date.now() - reasoningCache.at < 500) return reasoningCache.roots
  const roots = new Set<HTMLElement>()
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(REASONING_SELECTOR))) {
    if (!visible(el)) continue
    const text = (el.innerText ?? '').trim()
    if (text.length > 20) roots.add(el)
  }

  if (roots.size === 0) {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('button, [role="button"], summary, div, span')
    ).filter(visible)
    const headers = candidates.filter((header) => {
      const text = (header.innerText ?? '').trim()
      return Boolean(text) && text.length <= 90 && THINKING_HEADER.test(text)
    })
    // Keep the deepest header node. A panel that contains the header text also
    // matches the regex; using it would select the whole chat as "reasoning".
    const leafHeaders = headers.filter(
      (header) => !headers.some((other) => other !== header && header.contains(other))
    )
    for (const header of leafHeaders) {
      const headerText = (header.innerText ?? '').trim()
      let node = header.parentElement
      for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
        if (node === document.body) break
        const text = (node.innerText ?? '').trim()
        if (text.length > headerText.length + 4) {
          if (text.length < 30000) roots.add(node)
          break
        }
      }
    }
  }

  const list = Array.from(roots)
  const unique = list.filter(
    (root) => !list.some((other) => other !== root && other.contains(root))
  )
  unique.sort((a, b) => {
    if (a === b) return 0
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  })
  reasoningCache = { roots: unique, at: Date.now() }
  return unique
}

function isReasoningElement(el: Element): boolean {
  const roots = findReasoningRoots()
  return roots.some((root) => root.contains(el))
}

function cleanReasoningText(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => {
      const text = line.trim()
      if (!text) return false
      if (THINKING_HEADER.test(text)) return false
      if (/^用时\s*\d+|^\d+\s*秒|^Thought for/i.test(text)) return false
      return true
    })
    .join('\n')
    .trim()
    .slice(0, 30000)
}

function extractReasoningText(
  initialRoots?: Set<Element>,
  initialTexts?: Set<string>
): string {
  const roots = findReasoningRoots()
  if (roots.length === 0) return ''
  // Only the newest assistant turn has the current thinking process. Older
  // expanded panels remain in the DOM and must not be concatenated.
  let chosen: Element | undefined
  if (initialRoots) {
    const fresh = roots.filter((root) => !initialRoots.has(root))
    if (fresh.length > 0) {
      chosen = fresh[fresh.length - 1]
    } else {
      const last = roots[roots.length - 1]
      const text = last ? cleanReasoningText(extractTextWithMath(last)) : ''
      if (last && text && !initialTexts?.has(text)) chosen = last
    }
  } else {
    chosen = roots[roots.length - 1]
  }
  if (!chosen) return ''
  return cleanReasoningText(extractTextWithMath(chosen))
}

function stripStandaloneMarkers(value: string): string {
  return value
    .replace(/^\s*[-–—•*]?\s*-?\d+\s*$/gm, '')
    .replace(/[ \t]+-[ \t]*\d+[ \t]*$/gm, '')
    .replace(/[ \t]*[-–—•*][ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function assistantBlockText(block: HTMLElement): string {
  const structured = extractTextWithMath(block).trim()
  const visibleText = (block.innerText ?? '').trim()
  const markerOnlyLine = /^\s*[-–—•*]?\s*-?\d+\s*$/m
  const hasMarker = markerOnlyLine.test(block.textContent ?? '')
  if (!visibleText && !hasMarker) return structured
  // DeepSeek's search-answer renderer can leave only a hidden numeric marker
  // inside a markdown span while the visible list text lives in an enclosing
  // list/message node. Recover it through the same Markdown serializer so
  // bold/list formatting is not lost.
  if (hasMarker) {
    let parent = block.parentElement
    for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement) {
      if (parent === document.body) break
      const tag = parent.tagName
      const className = typeof parent.className === 'string' ? parent.className : ''
      const likelyAnswer =
        /(?:message|answer|content|markdown|bubble|chat-item)/i.test(className) ||
        ['LI', 'UL', 'OL', 'P', 'ARTICLE', 'SECTION'].includes(tag)
      if (!likelyAnswer) continue
      const text = extractTextWithMath(parent).trim()
      if (text && text.length > structured.length + 4 && text.length <= 10000) {
        return cleanAssistantTail(stripStandaloneMarkers(text))
      }
    }
  }
  if (structured.length < 8 && visibleText.length > structured.length * 2) return visibleText
  return hasMarker ? cleanAssistantTail(stripStandaloneMarkers(structured)) : structured
}

function contentText(): string {
  const root = findChatRoot() ?? document.body
  if (!root) return ''
  return extractTextWithMath(root, new Set(findReasoningRoots()))
}

function assistantBlocks(): HTMLElement[] {
  const root = findChatRoot() ?? document
  const all: HTMLElement[] = Array.from(
    root.querySelectorAll<HTMLElement>(
      '.ds-markdown, [class*="ds-markdown"], [class*="markdown"], pre, code, [class*="code-block"], [class*="codeblock"], [class*="highlight"]'
    )
  ).filter(
    (el): el is HTMLElement =>
      visible(el) && !el.closest('[contenteditable="true"]') && !isReasoningElement(el)
  )
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el)))
}

let userAnchorCache: { text: string; element: HTMLElement } | null = null

function findCurrentUserAnchor(userText: string): HTMLElement | null {
  const target = normalizeSpaces(userText)
  if (!target) return null
  if (userAnchorCache?.text === target && userAnchorCache.element.isConnected) {
    return userAnchorCache.element
  }
  const root = findChatRoot() ?? document.body
  if (!root) return null
  const tailTarget = normalizeSpaces(userText.split(/\r?\n/).filter(Boolean).pop() ?? target)
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>('div, p, article, section, span')
  ).filter((node) => visible(node) && !node.closest('[contenteditable="true"]'))
  let best: { element: HTMLElement; score: number; length: number } | null = null
  for (const node of nodes) {
    const text = normalizeSpaces(node.innerText ?? '')
    if (!text) continue
    let score = -1
    if (text === target) score = 0
    else if (text === tailTarget) score = 1
    else if (tailTarget.length >= 8 && text.includes(tailTarget)) score = 2
    else if (target.length >= 8 && target.includes(text) && text.length >= 8) score = 3
    if (score < 0) continue
    const className = typeof node.className === 'string' ? node.className : ''
    if (/user|question/i.test(className)) score -= 0.5
    if (/assistant|answer/i.test(className)) score += 0.5
    const candidate = { element: node, score, length: text.length }
    if (
      !best ||
      candidate.score < best.score ||
      (candidate.score === best.score && candidate.length <= best.length)
    ) {
      best = candidate
    }
  }
  if (!best) return null
  userAnchorCache = { text: target, element: best.element }
  return best.element
}

function assistantBlocksAfterUser(userText: string): HTMLElement[] {
  const blocks = assistantBlocks()
  const anchor = findCurrentUserAnchor(userText)
  if (!anchor) return blocks
  const after = blocks.filter(
    (block) =>
      anchor.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING
  )
  return after.length > 0 ? after : blocks
}

function lastAssistantText(): string {
  const blocks = assistantBlocks()
  return blocks.length ? assistantBlockText(blocks[blocks.length - 1]) : ''
}

function lastAssistantAnswer(): { text: string; reasoning: string } {
  const reasoning = extractReasoningText()
  const blocks = assistantBlocksAfterUser(lastUserText)
  if (blocks.length === 0) {
    const fallback = textAfterUser(lastUserText) || bodyDiffText(lastBaselineText, lastUserText)
    return { text: cleanAssistantTail(fallback), reasoning }
  }
  const last = blocks[blocks.length - 1]
  const skip = new Set(findReasoningRoots())
  let best = assistantBlockText(last)
  const container = last.closest(
    '[class*="message"], [class*="answer"], [class*="chat-item"], [class*="bubble"]'
  )
  if (container instanceof HTMLElement) {
    const text = extractTextWithMath(container, skip).trim()
    if (text.length > best.length && text.length <= 30000) best = text
  }
  const afterUser = textAfterUser(lastUserText)
  if (afterUser.length > best.length) best = afterUser
  return { text: cleanAssistantTail(best), reasoning }
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let index = 0
  while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) index += 1
  return index
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function removeUserTextPrefix(tail: string, userText: string): string {
  const target = normalizeSpaces(userText)
  if (!target) return tail
  const flat = normalizeSpaces(tail)
  if (flat.startsWith(target)) {
    let built = ''
    let index = 0
    while (index < tail.length && built.length < target.length) {
      const char = tail[index]
      if (/\s/.test(char)) {
        if (built && !built.endsWith(' ')) built += ' '
      } else {
        built += char
      }
      index += 1
    }
    while (index < tail.length && /\s/.test(tail[index])) index += 1
    return tail.slice(index).trim()
  }
  if (flat.includes(target)) {
    return tail
      .split(/\r?\n/)
      .filter((line) => !normalizeSpaces(line).startsWith(target))
      .join('\n')
      .trim()
  }
  return tail
}

function cleanAssistantTail(tail: string): string {
  const uiLabels =
    /^(发送|Send|停止生成|Stop generating|复制|Copy|重新生成|Regenerate|编辑|Edit|分享|Share)$/i
  const sidebarLines = new Set(
    (findSidebar()?.innerText ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  )
  return tail
    .split(/\r?\n/)
    .filter((line) => {
      const value = line.trim()
      return (
        value &&
        !uiLabels.test(value) &&
        !sidebarLines.has(value) &&
        !/^margin-screen-\d+\.(jpe?g|png|webp)$/i.test(value)
      )
    })
    .join('\n')
    .replace(
      /^(发送|Send|停止生成|Stop generating|复制|Copy|重新生成|Regenerate|编辑|Edit|分享|Share)\s*/i,
      ''
    )
    .replace(
      /\s*(发送|Send|停止生成|Stop generating|复制|Copy|重新生成|Regenerate|编辑|Edit|分享|Share)\s*$/i,
      ''
    )
    .replace(/\n?内容由 AI 生成.*$/i, '')
    .trim()
}

function bodyDiffText(baseline: string, userText: string): string {
  const current = contentText()
  if (!current) return ''
  const prefix = commonPrefixLength(baseline, current)
  let tail = current.slice(prefix).trim()
  if (!tail) return ''
  if (userText) {
    tail = removeUserTextPrefix(tail, userText)
  }
  return cleanAssistantTail(tail)
}

function textAfterUserIn(root: Element, userText: string): string {
  const current = extractTextWithMath(root, new Set(findReasoningRoots()))
  const lines = current.split(/\r?\n/)
  const userLines = userText
    .split(/\r?\n/)
    .map(normalizeSpaces)
    .filter(Boolean)
  const needle = userLines[userLines.length - 1] ?? ''
  if (!needle) return ''
  let index = -1
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = normalizeSpaces(lines[lineIndex])
    if (line && (line.includes(needle) || needle.includes(line))) index = lineIndex
  }
  if (index < 0) return ''
  return cleanAssistantTail(lines.slice(index + 1).join('\n'))
}

function textAfterUser(userText: string): string {
  if (!userText) return ''
  const roots: Element[] = []
  const chatRoot = findChatRoot()
  if (chatRoot) roots.push(chatRoot)
  if (document.body) roots.push(document.body)
  let best = ''
  for (const root of roots) {
    const text = textAfterUserIn(root, userText)
    if (text.length > best.length) best = text
  }
  return best
}

function genericCandidates(): Array<Record<string, unknown>> {
  const root = findChatRoot() ?? document
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(
      'article, [data-message-id], [data-testid*="message"], [class*="message"], [class*="markdown"]'
    )
  )
  return nodes
    .filter(visible)
    .map((el) => ({
      tag: el.tagName,
      className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
      textLength: extractTextWithMath(el).trim().length,
      preview: extractTextWithMath(el).trim().slice(0, 80)
    }))
    .filter((item) => Number(item.textLength) > 20)
    .slice(-12)
}

let lastBaselineText = ''
let lastUserText = ''

function isLoginPage(): boolean {
  const path = location.pathname.toLowerCase()
  if (/sign[_-]?in|login/.test(path)) return true
  if (findComposer()) return false
  const text = (document.body?.innerText ?? '').slice(0, 2000)
  return /登录|sign in|log in/i.test(text)
}

function state() {
  return {
    url: location.href,
    title: document.title,
    loginRequired: isLoginPage(),
    composerReady: Boolean(findComposer()),
    assistantCount: assistantBlocks().length,
    host: location.hostname
  }
}

function emitStream(payload: Record<string, unknown>): void {
  ipcRenderer.send('deepseek:stream', payload)
}

function respond(id: string, ok: boolean, data?: unknown, error?: BridgeError): void {
  ipcRenderer.send('deepseek:response', { id, ok, data, error })
}

async function waitFor<T>(fn: () => T | null, timeoutMs: number, interval = 150): Promise<T | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = fn()
    if (value) return value
    await sleep(interval)
  }
  return null
}

async function watchAssistant(
  requestId: string,
  assistantId: string,
  projectId: string,
  initialBlockTexts: Set<string>,
  initialLastText: string,
  initialReasoningRoots: Set<Element>,
  initialReasoningTexts: Set<string>,
  startedAt: number,
  baselineText: string,
  userText: string
): Promise<void> {
  let lastText = ''
  let lastReasoning = ''
  let stableSince = Date.now()
  let sawText = false
  let sawReasoning = false
  while (Date.now() - startedAt < 180_000) {
    await sleep(250)
    // Reasoning roots change as soon as a new thinking panel mounts. Never
    // answer/filter this turn from a cache captured while the old panel was
    // the newest one.
    reasoningCache = null
    const reasoningNow = extractReasoningText(initialReasoningRoots, initialReasoningTexts)
    const reasoning = reasoningNow || lastReasoning
    const blocks = assistantBlocksAfterUser(userText)
    const fresh = blocks
      .map((block) => ({ block, text: assistantBlockText(block) }))
      .filter(({ text }) => text && !initialBlockTexts.has(text))
    const freshTexts = Array.from(new Set(fresh.map(({ text }) => text)))
    let knownText = freshTexts.join('\n\n')
    if (!knownText && blocks.length) {
      const last = assistantBlockText(blocks[blocks.length - 1])
      if (last && last !== initialLastText && !initialBlockTexts.has(last)) knownText = last
    }
    // Only use whole-page text diffing when no known answer containers exist.
    // If answer blocks exist, diffing the page can leak previous messages into the answer.
    let fallbackText =
      blocks.length === 0 ? textAfterUser(userText) || bodyDiffText(baselineText, userText) : ''
    if (!knownText && blocks.length && Date.now() - startedAt > 3000) {
      // Some DeepSeek builds render the newest answer outside the known
      // markdown container. Fall back to the text after the current question.
      fallbackText = textAfterUser(userText) || fallbackText
    }
    const usableFallback = fallbackText.length >= 2 ? fallbackText : ''
    const text = (knownText || usableFallback).slice(0, 30000)
    const stop = findStopButton()
    const reasoningChanged = reasoning !== lastReasoning
    if (text !== lastText) sawText = true
    if (reasoning) sawReasoning = true
    if (text !== lastText || reasoningChanged) {
      if (text !== lastText) lastText = text
      lastReasoning = reasoning
      stableSince = Date.now()
      emitStream({
        requestId,
        assistantId,
        projectId,
        phase: 'delta',
        text: lastText,
        reasoning: lastReasoning
      })
      continue
    }
    if (sawText && !stop && Date.now() - stableSince > 6000) {
      emitStream({
        requestId,
        assistantId,
        projectId,
        phase: 'done',
        text: lastText,
        reasoning: lastReasoning
      })
      return
    }
    if (!sawText && !sawReasoning && !stop && Date.now() - startedAt > 60_000) {
      // On the first message after opening/creating a conversation, the page
      // can mount the answer under a different container than the one used for
      // later turns. Do one full-answer recovery pass before failing.
      const recovered = lastAssistantAnswer()
      if (
        recovered.text &&
        recovered.text !== initialLastText &&
        !initialBlockTexts.has(recovered.text)
      ) {
        emitStream({
          requestId,
          assistantId,
          projectId,
          phase: 'done',
          text: recovered.text,
          reasoning: recovered.reasoning || lastReasoning
        })
        return
      }
      emitStream({
        requestId,
        assistantId,
        projectId,
        phase: 'error',
        reasoning: lastReasoning,
        error: '网页已连接，但没有读取到回答。请打开“设置 → DeepSeek 网页 → 诊断”查看页面结构，或打开网页面板确认回答是否已经出现。'
      })
      return
    }
  }
  emitStream({
    requestId,
    assistantId,
    projectId,
    phase: 'error',
    reasoning: lastReasoning,
    error: '等待回答超时（180 秒）。'
  })
}

function dataUrlToFile(dataUrl: string): File {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/)
  if (!match) throw new Error('Invalid image data URL')
  const mime = match[1] || 'image/jpeg'
  const payload = match[3] || ''
  const binary = match[2] ? atob(payload) : decodeURIComponent(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], `margin-screen-${Date.now()}.jpg`, { type: mime })
}

function findFileInput(): HTMLInputElement | null {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
  const imageInputs = inputs.filter((input) => !input.accept || /image|png|jpe?g|webp/i.test(input.accept))
  return imageInputs[imageInputs.length - 1] ?? inputs[inputs.length - 1] ?? null
}

function findAttachButton(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, [role="button"], div[class*="button"]')
  ).filter(visible)
  for (const el of candidates) {
    const label = labelOf(el)
    if (/发送|send|停止|stop/i.test(label)) continue
    if (/附件|上传|图片|图像|文件|image|attach|upload|file/i.test(label)) return el
  }
  return null
}

interface AttachmentSnapshot {
  images: Set<string>
  chips: Set<string>
  childCount: number
  height: number
}

function attachmentSnapshot(composer?: HTMLElement): AttachmentSnapshot {
  const images = new Set(
    Array.from(document.querySelectorAll<HTMLImageElement>('img'))
      .map((img) => img.src)
      .filter((src) => src.startsWith('blob:') || src.startsWith('data:image'))
  )
  const chips = new Set(
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[class*="attachment"], [class*="file-item"], [class*="upload"], [class*="preview"]'
      )
    )
      .map((el) => (el.innerText ?? '').trim())
      .filter(Boolean)
  )
  const container =
    composer?.closest('form') ??
    composer?.parentElement?.parentElement ??
    composer?.parentElement ??
    null
  return {
    images,
    chips,
    childCount: container?.childElementCount ?? 0,
    height: container ? container.getBoundingClientRect().height : 0
  }
}

function hasNewAttachment(
  composer: HTMLElement,
  snapshot: AttachmentSnapshot,
  fileName: string
): boolean {
  const bodyText = document.body?.innerText ?? ''
  if (fileName && bodyText.includes(fileName)) return true
  const baseName = fileName.replace(/\.[^.]+$/, '')
  if (baseName && bodyText.includes(baseName)) return true

  const now = attachmentSnapshot(composer)
  for (const src of now.images) {
    if (!snapshot.images.has(src)) return true
  }
  for (const chip of now.chips) {
    if (!snapshot.chips.has(chip)) return true
  }
  if (
    now.childCount > snapshot.childCount ||
    (snapshot.height > 0 && now.height > snapshot.height + 8)
  ) {
    return true
  }

  const root =
    composer.closest('form') ??
    composer.parentElement?.parentElement ??
    document.querySelector('main') ??
    document.body
  const removeControls = Array.from(
    root.querySelectorAll<HTMLElement>('button, [role="button"], [aria-label]')
  ).filter(visible)
  if (
    removeControls.some((el) =>
      /删除附件|移除附件|删除图片|remove attachment|remove image|remove file/i.test(labelOf(el))
    )
  ) {
    return true
  }

  return false
}

async function waitForAttachment(
  composer: HTMLElement,
  snapshot: AttachmentSnapshot,
  fileName: string,
  timeout = 5000
): Promise<boolean> {
  return Boolean(
    await waitFor(
      () => (hasNewAttachment(composer, snapshot, fileName) ? true : null),
      timeout,
      150
    )
  )
}

let imageUploadSupported: boolean | null = null
let imageUploadRetryAt = 0
let lastSeenUrl = location.href

async function tryAttachImage(dataUrl: string): Promise<boolean> {
  if (location.href !== lastSeenUrl) {
    lastSeenUrl = location.href
    imageUploadSupported = null
    imageUploadRetryAt = 0
  }
  if (imageUploadSupported === false && Date.now() < imageUploadRetryAt) return false
  const composer = findComposer()
  if (!composer) return false
  let file: File
  try {
    file = dataUrlToFile(dataUrl)
  } catch {
    return false
  }
  const transfer = new DataTransfer()
  transfer.items.add(file)

  let input = findFileInput()
  if (!input) {
    const attachButton = findAttachButton()
    if (attachButton) {
      attachButton.click()
      await sleep(250)
      input = findFileInput()
    }
  }

  // Only run ONE upload strategy. Running file-input, paste and drop one after
  // another is what caused duplicate images when preview detection failed.
  if (input) {
    const snapshot = attachmentSnapshot(composer)
    try {
      input.files = transfer.files
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      if (await waitForAttachment(composer, snapshot, file.name, 6000)) {
        imageUploadSupported = true
        imageUploadRetryAt = 0
        return true
      }
    } catch {
      // The input exists but the page rejected programmatic file assignment.
      // Do not also paste: that is how duplicate images happen.
    }
    imageUploadSupported = false
    imageUploadRetryAt = Date.now() + 60_000
    return false
  }

  const pasteSnapshot = attachmentSnapshot(composer)
  try {
    composer.focus()
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', { value: transfer })
    composer.dispatchEvent(paste)
    document.dispatchEvent(paste)
    if (await waitForAttachment(composer, pasteSnapshot, file.name, 5000)) {
      imageUploadSupported = true
      imageUploadRetryAt = 0
      return true
    }
  } catch {
    // no image support
  }

  imageUploadSupported = false
  imageUploadRetryAt = Date.now() + 60_000
  return false
}

async function sendMessage(cmd: Command): Promise<void> {
  const text = String(cmd.payload?.text ?? '')
  const fallbackText = String(cmd.payload?.fallbackText ?? text)
  const imageDataUrl = String(cmd.payload?.imageDataUrl ?? '')
  const assistantId = String(cmd.payload?.assistantId ?? '')
  const projectId = String(cmd.payload?.projectId ?? '')
  if (!text.trim()) {
    respond(cmd.id, false, undefined, { code: 'EMPTY_MESSAGE', message: '消息为空。' })
    return
  }
  if (!navigator.onLine) {
    respond(cmd.id, false, undefined, {
      code: 'NETWORK_OFFLINE',
      message: '网络未连接，请检查网络后点击“重连”再发送。'
    })
    return
  }
  const composer = findComposer()
  if (!composer) {
    respond(cmd.id, false, undefined, {
      code: 'COMPOSER_NOT_FOUND',
      message: '找不到 DeepSeek 输入框。请打开网页面板确认已登录，或页面结构可能已变化。'
    })
    return
  }
  if (isLoginPage()) {
    respond(cmd.id, false, undefined, {
      code: 'LOGIN_REQUIRED',
      message: 'DeepSeek 网页需要登录。请点击“打开网页”完成登录。'
    })
    return
  }

  let imageAttached = false
  if (imageDataUrl) {
    imageAttached = await tryAttachImage(imageDataUrl)
  }
  const actualText = imageAttached ? text : fallbackText || text

  const initialBlocks = assistantBlocks()
  const startCount = initialBlocks.length
  const initialBlockTexts = new Set(
    initialBlocks.map((block) => assistantBlockText(block)).filter(Boolean)
  )
  const initialLastText = startCount ? assistantBlockText(initialBlocks[startCount - 1]) : ''
  reasoningCache = null
  userAnchorCache = null
  const initialReasoningRoots = new Set(findReasoningRoots())
  const initialReasoningTexts = new Set(
    Array.from(initialReasoningRoots)
      .map((root) => cleanReasoningText(extractTextWithMath(root)))
      .filter(Boolean)
  )
  const startedAt = Date.now()
  const baselineText = contentText()
  lastBaselineText = baselineText
  lastUserText = actualText
  setComposerText(composer, actualText)
  await sleep(160)
  if (imageAttached) {
    await waitFor(() => (findSendButton() ? true : null), 5000, 150)
  }
  const button = findSendButton()
  if (button) {
    button.click()
  } else {
    pressEnter(composer)
  }
  let sent = await waitFor(
    () => (composerText(composer).trim() === '' ? true : null),
    3500,
    120
  )
  if (!sent) {
    pressEnter(composer)
    sent = await waitFor(
      () => (composerText(composer).trim() === '' ? true : null),
      2500,
      120
    )
  }
  if (!sent) {
    respond(cmd.id, false, undefined, {
      code: 'SEND_NOT_CONFIRMED',
      message: '消息没有确认发出。请打开网页面板检查，应用不会自动重发以免重复。'
    })
    return
  }

  reasoningCache = null
  respond(cmd.id, true, {
    sent: true,
    url: location.href,
    startCount,
    imageAttached,
    usedFallbackText: !imageAttached && Boolean(imageDataUrl)
  })
  void watchAssistant(
    cmd.id,
    assistantId,
    projectId,
    initialBlockTexts,
    initialLastText,
    initialReasoningRoots,
    initialReasoningTexts,
    startedAt,
    baselineText,
    actualText
  )
}

async function runCommand(cmd: Command): Promise<void> {
  try {
    switch (cmd.type) {
      case 'getState':
        respond(cmd.id, true, state())
        return
      case 'send':
        await sendMessage(cmd)
        return
      case 'stop': {
        const stop = findStopButton()
        if (stop) {
          stop.click()
          respond(cmd.id, true, { stopped: true })
        } else {
          respond(cmd.id, true, { stopped: false })
        }
        return
      }
      case 'getLastAssistant': {
        const answer = lastAssistantAnswer()
        respond(cmd.id, true, { ...answer, url: location.href })
        return
      }
      case 'diagnose':
        respond(cmd.id, true, {
          ...state(),
          documentHidden: document.hidden,
          composerTag: findComposer()?.tagName ?? null,
          sendFound: Boolean(findSendButton()),
          stopFound: Boolean(findStopButton()),
          assistantBlocks: assistantBlocks().length,
          assistantBlockPreviews: assistantBlocks().slice(-8).map((block) => ({
            tag: block.tagName,
            className: typeof block.className === 'string' ? block.className.slice(0, 100) : '',
            text: assistantBlockText(block).slice(0, 240)
          })),
          knownAssistantPreview: lastAssistantText().slice(0, 200),
          reasoningPreview: extractReasoningText().slice(0, 300),
          reasoningRoots: findReasoningRoots().map((root) => ({
            tag: root.tagName,
            className: typeof root.className === 'string' ? root.className.slice(0, 120) : '',
            length: (root.innerText ?? '').length
          })),
          bodyDiffPreview: bodyDiffText(lastBaselineText, lastUserText).slice(0, 300),
          chatRoot: (() => {
            const root = findChatRoot()
            if (!root) return null
            const rect = root.getBoundingClientRect()
            return {
              tag: root.tagName,
              className: typeof root.className === 'string' ? root.className.slice(0, 120) : '',
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              left: Math.round(rect.left)
            }
          })(),
          sidebar: (() => {
            const el = findSidebar()
            if (!el) return null
            const rect = el.getBoundingClientRect()
            return {
              tag: el.tagName,
              className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          })(),
          sampleClasses: assistantBlocks()
            .slice(-3)
            .map((el) => el.className),
          genericCandidates: genericCandidates()
        })
        return
      case 'focusComposer': {
        const composer = findComposer()
        composer?.focus()
        respond(cmd.id, true, { focused: Boolean(composer) })
        return
      }
      default:
        respond(cmd.id, false, undefined, { code: 'UNKNOWN_COMMAND', message: `未知命令 ${cmd.type}` })
    }
  } catch (error) {
    respond(cmd.id, false, undefined, {
      code: 'BRIDGE_EXCEPTION',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

ipcRenderer.on('deepseek:command', (_event, cmd: Command) => {
  void runCommand(cmd)
})

function reportState(): void {
  try {
    ipcRenderer.send('deepseek:state', state())
  } catch {
    // page may be unloading
  }
}

window.addEventListener('DOMContentLoaded', reportState)
window.addEventListener('load', reportState)
setInterval(reportState, 2500)

if (location.hostname.endsWith('deepseek.com')) {
  reportState()
}
