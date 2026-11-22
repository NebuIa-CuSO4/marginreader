import { net } from 'electron'
import { OPENAI_RESOURCE } from './chatgptAuth'
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

export function supportsWebSearch(provider: ApiProvider): boolean {
  return provider.kind === 'chatgpt' || provider.kind === 'openai-responses'
}

export async function listChatGPTModels(accessToken: string): Promise<string[]> {
  const response = await net.fetch(OPENAI_RESOURCE + '/models', {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'error', signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new ApiError('CHATGPT_MODELS', `无法获取 ChatGPT 模型（HTTP ${response.status}）。`)
  const data = await response.json() as { models?: Array<{ slug: string; visibility: string }> }
  const models = [...new Set((data.models ?? []).filter((item) => item.visibility === 'list' && item.slug).map((item) => item.slug))]
  if (!models.length) throw new ApiError('CHATGPT_MODELS', '当前账号没有可供 Margin 使用的模型。')
  return models
}

function responsesBody(model: string, messages: ApiMessage[], webSearch: boolean) {
  return {
    model, stream: true, store: false,
    input: messages.map(({ role, content }) => {
      if (role !== 'user' || typeof content === 'string') {
        return { role: role === 'system' ? 'developer' : role, content }
      }
      return { role, content: content.map((part) => part.type === 'text'
        ? { type: 'input_text', text: part.text }
        : { type: 'input_image', image_url: part.image_url.url, detail: 'auto' }) }
    }),
    ...(webSearch ? { tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' } } : {})
  }
}

export async function streamChat(
  provider: ApiProvider,
  apiKey: string,
  model: string,
  messages: ApiMessage[],
  signal: AbortSignal,
  onDelta: (text: string) => void,
  onReasoning: (text: string) => void,
  webSearch = false
): Promise<StreamResult> {
  const responses = supportsWebSearch(provider)
  if (webSearch && !responses) throw new ApiError('SEARCH_UNSUPPORTED', '当前服务不支持内置联网搜索。')
  const response = await net.fetch(responses ? OPENAI_RESOURCE + '/responses' : endpoint(provider.baseUrl), {
    ...(responses ? { redirect: 'error' as const } : {}),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify(responses ? responsesBody(model, messages, webSearch) : { model, messages, stream: true }),
    signal
  }).catch((error: unknown) => {
    if (signal.aborted && signal.reason?.name === 'AbortError') {
      throw new ApiError('API_ABORTED', '已停止生成。')
    }
    throw error
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    if (provider.kind === 'chatgpt' && [401, 403, 429].includes(response.status)) {
      throw new ApiError('CHATGPT_ACCESS', `ChatGPT 授权、模型权限或额度不可用（HTTP ${response.status}）：${text.slice(0, 180)}`)
    }
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
    if (data === '[DONE]') return !responses
    let payload: any
    try {
      payload = JSON.parse(data)
    } catch {
      return false
    }
    if (responses) {
      if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        content += payload.delta
        onDelta(content)
      }
      if (payload.type === 'response.reasoning_summary_text.delta' && typeof payload.delta === 'string') {
        reasoning += payload.delta
        onReasoning(reasoning)
      }
      if (['error', 'response.failed', 'response.incomplete'].includes(payload.type)) {
        const error = payload.response?.error ?? payload
        throw new ApiError(String(error.code ?? 'API_RESPONSE'), String(
          error.message ?? payload.response?.incomplete_details?.reason ?? '生成未完成。'
        ))
      }
      if (payload.type !== 'response.completed') return false
      const sources = new Map<string, string>()
      const outputText: string[] = []
      for (const item of payload.response?.output ?? []) {
        if (item.type !== 'message') continue
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && typeof part.text === 'string') outputText.push(part.text)
          for (const annotation of part.annotations ?? []) {
            if (annotation.type === 'url_citation' && typeof annotation.url === 'string' && /^https?:\/\//i.test(annotation.url)) {
              sources.set(annotation.url, String(annotation.title || annotation.url))
            }
          }
        }
      }
      if (outputText.length) content = outputText.join('\n\n')
      if (sources.size) {
        content += '\n\n**来源**\n\n' + [...sources].map(([url, title]) =>
          '- [' + title.replace(/[\[\]\\\r\n]/g, ' ') + '](<' + url.replace(/[<>\s]/g, encodeURIComponent) + '>)'
        ).join('\n')
      }
      const totals = payload.response?.usage
      if (totals) usage = {
        promptTokens: totals.input_tokens ?? 0,
        completionTokens: totals.output_tokens ?? 0,
        totalTokens: totals.total_tokens ?? 0
      }
      finishReason = 'completed'
      if (!content) throw new ApiError('API_EMPTY', 'API 没有返回内容。')
      return true
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
    if (buffer && processLine(buffer)) return { content, reasoning, usage, finishReason }
    if (responses) throw new ApiError('API_STREAM', 'Responses API 连接在生成完成前关闭。')
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

async function probeVision(
  provider: ApiProvider,
  apiKey: string,
  model: string
): Promise<{ ok: boolean; message: string }> {
  const image =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  try {
    if (supportsWebSearch(provider)) {
      await streamChat(provider, apiKey, model, [{ role: 'user', content: [
        { type: 'text', text: '这张图是什么颜色？只回答颜色。' },
        { type: 'image_url', image_url: { url: image } }
      ] }], AbortSignal.timeout(30_000), () => {}, () => {})
      return { ok: true, message: `模型 ${model} 接受了图片输入。` }
    }
    const response = await net.fetch(endpoint(provider.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张图是什么颜色？只回答颜色。' },
              { type: 'image_url', image_url: { url: image } }
            ]
          }
        ],
        max_tokens: 16,
        stream: false
      })
    })
    if (response.ok) {
      return { ok: true, message: `模型 ${model} 接受了图片输入。` }
    }
    const text = await response.text().catch(() => '')
    let detail = text
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      detail = parsed.error?.message ?? text
    } catch {
      // keep raw text
    }
    const rejected = /image|vision|multimodal|图片|不支持/i.test(detail)
    return {
      ok: false,
      message: rejected
        ? `模型 ${model} 不支持图片输入：${detail.slice(0, 160)}`
        : `模型 ${model} 未接受图片（HTTP ${response.status}）：${detail.slice(0, 160)}`
    }
  } catch (error) {
    return { ok: false, message: `测试失败：${(error as Error).message}` }
  }
}

async function testChatEndpoint(
  provider: ApiProvider,
  apiKey: string,
  model: string
): Promise<{ ok: boolean; message: string }> {
  const response = await net.fetch(endpoint(provider.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model || 'default',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    })
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw statusError(response.status, text)
  }
  return { ok: true, message: `模型 ${model} 可用。` }
}

export async function testApiProvider(
  provider: ApiProvider,
  apiKey: string,
  model: string,
  probeImages: boolean
): Promise<{ models: string[]; chat: { ok: boolean; message: string }; vision?: { ok: boolean; message: string } }> {
  let models: string[] = []
  try {
    if (provider.kind === 'chatgpt') {
      models = await listChatGPTModels(apiKey)
    } else {
      const baseUrl = provider.kind === 'openai-responses' ? OPENAI_RESOURCE : provider.baseUrl
      const response = await net.fetch(modelsEndpoint(baseUrl), {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        ...(provider.kind === 'openai-responses' ? { redirect: 'error' as const } : {})
      })
      if (response.ok) {
        const payload = (await response.json()) as { data?: Array<{ id?: string }> }
        models = (payload.data ?? []).map((item) => String(item.id ?? '')).filter(Boolean)
      }
    }
  } catch (error) {
    if (provider.kind === 'chatgpt') throw error
    models = []
  }
  const target = model || provider.defaultModel || provider.models[0] || models[0] || ''
  if (supportsWebSearch(provider)) {
    const signal = AbortSignal.timeout(30_000)
    const messages: ApiMessage[] = [{ role: 'user', content: 'Reply with OK.' }]
    await streamChat(provider, apiKey, target, messages, signal, () => {}, () => {})
    return { models, chat: { ok: true, message: `模型 ${target} 可用。` },
      vision: probeImages ? await probeVision(provider, apiKey, target) : undefined }
  }
  const chat = await testChatEndpoint(provider, apiKey, target)
  const vision = probeImages ? await probeVision(provider, apiKey, target) : undefined
  return { models, chat, vision }
}
