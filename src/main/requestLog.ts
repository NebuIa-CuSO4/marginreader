import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRequestLog, RequestPart } from '../shared/types'
import type { ApiMessage } from './apiClient'
import { stripVocabBlock } from '../shared/vocab'

export const MAX_MESSAGE_CHARS = 70_000
export const MAX_CONTEXT_MESSAGES = 60

export interface BuiltRequest {
  messages: ApiMessage[]
  apiText: string
  imageDataUrl: string
  imageOmitted: boolean
  ocrApplied: boolean
  screenContextApplied: boolean
}

export function systemPrompt(projectTitle: string): string {
  return `你是页边（Margin），一个中文阅读与学习助手。当前项目：《${projectTitle}》。回答准确、清晰，优先使用 Markdown；数学公式使用 LaTeX。`
}

/**
 * Keeps the most recent history under a character budget. The conversation is
 * cut at a user boundary so an answer never appears without its question, and
 * the last available user/assistant pair is always kept.
 */
export function trimContext(messages: ChatMessage[]): ChatMessage[] {
  const recent = messages.slice(-MAX_CONTEXT_MESSAGES)
  let chars = 0
  let start = recent.length
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    chars += recent[index].content.length
    const isBoundary = recent[index].role === 'user'
    if (isBoundary) start = index
    if (isBoundary && start <= recent.length - 2 && chars > MAX_MESSAGE_CHARS) {
      start = index
      break
    }
    start = index
  }
  return recent.slice(start)
}

export function buildRequestMessages(
  projectTitle: string,
  history: ChatMessage[],
  userText: string,
  imageDataUrl: string,
  supportsVision: boolean
): ApiMessage[] {
  const result: ApiMessage[] = [{ role: 'system', content: systemPrompt(projectTitle) }]
  trimContext(history).forEach((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return
    result.push({
      role: message.role,
      content: message.role === 'assistant' ? stripVocabBlock(message.content) : message.content
    })
  })
  result.push({
    role: 'user',
    content:
      imageDataUrl && supportsVision
        ? [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: imageDataUrl } }
          ]
        : userText
  })
  return result
}

export function describeRequest(messages: ApiMessage[]): ChatRequestLog['request'] {
  return messages.map((message) => {
    if (typeof message.content === 'string') {
      return { role: message.role, text: message.content }
    }
    return {
      role: message.role,
      parts: message.content.map((part): RequestPart =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : {
              type: 'image_url',
              imageUrl: part.image_url.url.startsWith('data:') ? '' : part.image_url.url,
              description: part.image_url.url.startsWith('data:')
                ? describeImage(part.image_url.url)
                : part.image_url.url
            }
      )
    }
  })
}

export function describeImage(dataUrl: string): string {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/)
  if (!match) return '非 data URL'
  const bytes = Math.round((match[2].length * 3) / 4)
  return `${match[1]}，约 ${(bytes / 1024).toFixed(0)} KB`
}

export async function writeRequestLog(
  logDir: string,
  log: Omit<ChatRequestLog, 'images'> & { images: string[] }
): Promise<ChatRequestLog> {
  await fs.mkdir(logDir, { recursive: true })
  let images = log.images
  if (images.length > 0) {
    const fileNames = await Promise.all(
      log.images.map(async (dataUrl, index) => {
        const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]+)$/)
        if (!match) return ''
        const ext = match[1].includes('png') ? 'png' : match[1].split('+')[0]
        const file = `${log.requestId}-${index + 1}.${ext}`
        await fs.writeFile(path.join(logDir, file), Buffer.from(match[2], 'base64'))
        return file
      })
    )
    images = fileNames.filter((file) => file !== '')
  }
  const record = { ...log, images } as ChatRequestLog
  await fs.writeFile(
    path.join(logDir, `${log.requestId}.json`),
    JSON.stringify(record, null, 2),
    'utf8'
  )
  return record
}

export async function readRequestLogs(logDir: string, limit = 50): Promise<ChatRequestLog[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(logDir)
  } catch {
    return []
  }
  const files = entries
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
  const logs: ChatRequestLog[] = []
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(logDir, file), 'utf8')
      logs.push(JSON.parse(raw) as ChatRequestLog)
    } catch {
      // ignore corrupt entries
    }
  }
  return logs
}

export function newRequestId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
}

export function buildRequest(
  projectId: string,
  assistantId: string,
  requestId: string,
  projectTitle: string,
  history: ChatMessage[],
  text: string,
  displayText: string,
  imageDataUrl: string,
  screenContext: { applied: boolean; image: string },
  ocrText: string,
  provider: { id: string; name: string; supportsVision: boolean },
  model: string
): { built: BuiltRequest; log: Omit<ChatRequestLog, 'images'> & { images: string[] } } {
  let apiText = text
  let image = imageDataUrl
  let imageOmitted = false
  let ocrApplied = false
  if (image && !provider.supportsVision) {
    // Text-only model: the picture itself cannot travel, so fall back to OCR text.
    if (ocrText.trim()) {
      apiText = `${apiText}\n\n【截图文字】\n${ocrText.trim()}`
      ocrApplied = true
    } else {
      imageOmitted = true
    }
    image = ''
  } else if (image) {
    // Vision model: send the real image only. Do not append OCR text as well,
    // otherwise the model receives the same content twice.
    ocrApplied = false
  }
  const messages = buildRequestMessages(projectTitle, history, apiText, image, provider.supportsVision)
  const log = {
    requestId,
    projectId,
    assistantId,
    createdAt: Date.now(),
    provider: provider.name,
    providerId: provider.id,
    model,
    supportsVision: provider.supportsVision,
    displayText,
    apiText,
    screenContextApplied: screenContext.applied,
    imageAttached: Boolean(image),
    imageOmitted,
    ocrApplied,
    trim: {
      historyCount: history.length,
      sentMessageCount: messages.length,
      charLimit: MAX_MESSAGE_CHARS,
      messageLimit: MAX_CONTEXT_MESSAGES
    },
    request: describeRequest(messages),
    images: [image, screenContext.image].filter(Boolean)
  }
  return {
    built: {
      messages,
      apiText,
      imageDataUrl: image,
      imageOmitted,
      ocrApplied,
      screenContextApplied: screenContext.applied
    },
    log
  }
}
