import { net } from 'electron'
import type { ApiProvider, ApiUsage } from '../shared/types'

export type ApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ApiContentPart[]
}

export interface StreamResult {
  content: string
  reasoning: string
  usage: ApiUsage | null
  finishReason: string | null
}

export class ApiError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
}

function modelsEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(base)
    ? base.replace(/\/chat\/completions$/i, '/models')
    : `${base}/models`
}

function statusError(status: number, text: string): ApiError {
  if (status === 401 || status === 403) {
    return new ApiError('API_AUTH', 'API Key 无效或没有权限，请在设置中检查。')
  }
  if (status === 429) {
    return new ApiError('API_RATE_LIMIT', 'API 请求过于频繁，请稍后再试。')
  }
  if (status === 400 && /context|token/i.test(text)) {
    return new ApiError('API_CONTEXT', '对话上下文超出模型限制。')
  }
  return new ApiError('API_HTTP', `API 请求失败（HTTP ${status}）：${text.slice(0, 180)}`)
}

export async function streamChat(
  provider: ApiProvider,
  apiKey: string,
  model: string,
  messages: ApiMessage[],
  signal: AbortSignal,
  onDelta: (text: string) => void,
  onReasoning: (text: string) => void
): Promise<StreamResult> {
  const response = await net.fetch(endpoint(provider.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true
    }),
    signal
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw statusError(response.status, text)
  }
  if (!response.body) throw new ApiError('API_STREAM', 'API 没有返回流式响应。')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  let usage: ApiUsage | null = null
  let finishReason: string | null = null

  const processLine = (line: string): boolean => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return false
    const data = trimmed.slice(5).trim()
    if (!data) return false
    if (data === '[DONE]') return true
    let payload: any
    try {
      payload = JSON.parse(data)
    } catch {
      return false
    }
    if (payload?.usage) {
      usage = {
        promptTokens: Number(payload.usage.prompt_tokens ?? 0),
        completionTokens: Number(payload.usage.completion_tokens ?? 0),
        totalTokens: Number(payload.usage.total_tokens ?? 0)
      }
    }
    const choice = payload?.choices?.[0]
    if (!choice) return false
    const deltaText =
      typeof choice.delta?.content === 'string'
        ? choice.delta.content
        : typeof choice.message?.content === 'string'
          ? choice.message.content
          : ''
    const deltaReasoning =
      typeof choice.delta?.reasoning_content === 'string'
        ? choice.delta.reasoning_content
        : typeof choice.message?.reasoning_content === 'string'
          ? choice.message.reasoning_content
          : ''
    if (deltaText) {
      content += deltaText
      onDelta(content)
    }
    if (deltaReasoning) {
      reasoning += deltaReasoning
      onReasoning(reasoning)
    }
    if (choice.finish_reason) finishReason = String(choice.finish_reason)
    return false
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (processLine(line)) {
          await reader.cancel().catch(() => undefined)
          return { content, reasoning, usage, finishReason }
        }
      }
    }
    if (buffer) processLine(buffer)
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new ApiError('API_ABORTED', '已停止生成。')
    }
    throw error instanceof ApiError
      ? error
      : new ApiError('API_NETWORK', `API 网络请求失败：${(error as Error).message}`)
  }
  if (!content && !reasoning) {
    throw new ApiError('API_EMPTY', 'API 没有返回内容。')
  }
  return { content, reasoning, usage, finishReason }
}

async function testChatEndpoint(provider: ApiProvider, apiKey: string): Promise<void> {
  const response = await net.fetch(endpoint(provider.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: provider.defaultModel || provider.models[0] || 'default',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    })
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw statusError(response.status, text)
  }
}

export async function testApiProvider(
  provider: ApiProvider,
  apiKey: string
): Promise<{ models: string[] }> {
  const response = await net.fetch(modelsEndpoint(provider.baseUrl), {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  })
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      await testChatEndpoint(provider, apiKey)
      return { models: [] }
    }
    const text = await response.text().catch(() => '')
    throw statusError(response.status, text)
  }
  const payload = (await response.json()) as { data?: Array<{ id?: string }> }
  const models = (payload.data ?? [])
    .map((item) => String(item.id ?? ''))
    .filter(Boolean)
  return { models }
}
