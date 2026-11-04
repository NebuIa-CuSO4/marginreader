export interface ParsedVocab {
  word: string
  phonetic: string
  meaning: string
  example: string
  source: string
}

const BLOCK_RE = /\[VOCAB\]([\s\S]*?)\[\/VOCAB\]/i
const FENCED_BLOCK_RE = /```[a-z]*\s*\[VOCAB\][\s\S]*?\[\/VOCAB\]\s*```/gi

export function stripVocabBlock(content: string): string {
  return content
    .replace(FENCED_BLOCK_RE, '')
    .replace(BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractQuotedSource(question: string): string {
  const quoted = question.match(/"""([\s\S]*?)"""/)
  if (quoted?.[1]) return quoted[1].trim()
  const fenced = question.match(/```(?:text)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const compact = question.trim()
  if (compact && compact.length <= 160 && !compact.includes('\n')) return compact
  return ''
}

function fieldValue(block: string, keys: string[]): string {
  const lines = block.split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^\s*([^:：]+)[:：]\s*(.*)$/)
    if (!match) continue
    const key = match[1].trim().toLowerCase()
    if (keys.some((candidate) => key === candidate || key.includes(candidate))) {
      return match[2].trim()
    }
  }
  return ''
}

function sectionValue(content: string, headings: string[]): string {
  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:#{1,4}\\s*)?(?:${headings.join('|')})\\s*[:：]?\\s*\\n?([\\s\\S]*?)(?=\\n\\s*(?:#{1,4}\\s*)?(?:释义|意思|翻译|音标|例句|原句|example|meaning|phonetic|word|sentence)\\s*[:：]?|$)`,
    'i'
  )
  const match = content.match(pattern)
  if (!match?.[1]) return ''
  return match[1]
    .replace(/^[\s>*\-•]+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 500)
}

function firstUsefulLine(content: string): string {
  return (
    content
      .split(/\r?\n/)
      .map((line) => line.replace(/^[#>*\-•\d.\s]+/, '').trim())
      .find((line) => line && !/^\[VOCAB\]/i.test(line)) ?? ''
  )
}

export function parseVocabAnswer(answer: string, question = ''): ParsedVocab {
  const blockMatch = answer.match(BLOCK_RE)
  const block = blockMatch?.[1] ?? ''
  const quoted = extractQuotedSource(question)
    .replace(/^(请翻译|请解释|翻译|解释|请分析)\s*[:：]?\s*/i, '')
    .trim()
  const clean = stripVocabBlock(answer)

  const word =
    fieldValue(block, ['word', '单词', '短语', 'term', 'phrase']) ||
    quoted ||
    clean.match(/\*\*([^*\n]{2,60})\*\*/)?.[1]?.trim() ||
    firstUsefulLine(clean).slice(0, 80)

  const phonetic =
    fieldValue(block, ['phonetic', '音标', 'pronunciation']) ||
    clean.match(/\/([^/\n]{2,48})\//)?.[1]?.trim() ||
    clean.match(/\[([^\]]{2,48})\]/)?.[1]?.trim() ||
    ''

  const meaning =
    fieldValue(block, ['meaning', '释义', '意思', '翻译', 'definition']) ||
    sectionValue(clean, ['释义', '意思', '翻译', 'meaning', 'definition']) ||
    clean.slice(0, 500)

  const example =
    fieldValue(block, ['example', '例句', 'sentence', '原句']) ||
    sectionValue(clean, ['例句', 'example', 'sentence', '原句']) ||
    ''

  const source =
    fieldValue(block, ['source', '出处', '来源']) ||
    (quoted && quoted.toLowerCase() !== word.toLowerCase() ? quoted : '')

  return {
    word: word.trim(),
    phonetic: phonetic.trim(),
    meaning: meaning.trim(),
    example: example.trim(),
    source: source.trim()
  }
}

export const VOCAB_FORMAT_INSTRUCTION = `如果选中的内容包含值得记录的单词或短语，请在回答最后追加一个词汇块，严格使用下面的格式，不要放进代码块，不要解释这个块：
[VOCAB]
word: 单词或短语
phonetic: 音标；不确定就留空
meaning: 简洁中文释义
example: 原文例句，或一个自然的英文例句
[/VOCAB]
如果只是长段落且没有明确的单词/短语，不要输出这个块。`
