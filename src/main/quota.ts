import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { app, net } from 'electron'
import type { ApiUsage, CodexQuota, CostRange, DeepSeekQuota, QuotaWindow } from '../shared/types'
import { codexExecutables } from './codexExecutable'
import { readRequestLogs } from './requestLog'

interface CodexWindow {
  usedPercent?: number
  windowDurationMins?: number | null
  resetsAt?: number | null
}

interface CodexLimits {
  primary?: CodexWindow | null
  secondary?: CodexWindow | null
}

export function parseCodexQuota(result: {
  rateLimits?: CodexLimits
  rateLimitsByLimitId?: Record<string, CodexLimits>
}): CodexQuota {
  const limits = result.rateLimitsByLimitId?.codex ?? result.rateLimits
  const windows = [limits?.primary, limits?.secondary]
  function windowFor(minutes: number): QuotaWindow | null {
    const entry = windows.find((item) => item?.windowDurationMins === minutes)
    const used = entry?.usedPercent
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null
    const reset = entry?.resetsAt
    return { remaining: 100 - used, resetsAt: typeof reset === 'number' && reset > 0 ? reset * 1000 : null }
  }
  return { fiveHours: windowFor(300), week: windowFor(10_080) }
}

class CodexLaunchError extends Error {}

async function queryCodexQuota(executable: string): Promise<CodexQuota> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      cwd: tmpdir(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const lines = createInterface({ input: child.stdout })
    let initialized = false
    let settled = false
    let timeout = setTimeout(() => fail(new CodexLaunchError('Codex 启动超时。')), 4_000)

    function cleanup(): void {
      settled = true
      clearTimeout(timeout)
      lines.close()
      child.kill()
    }
    function fail(error: Error): void {
      if (settled) return
      cleanup()
      reject(error)
    }
    function failConnection(): void {
      fail(initialized ? new Error('Codex 连接已断开，请重试。') : new CodexLaunchError('无法启动 Codex。'))
    }
    function send(input: object): void {
      child.stdin.write(JSON.stringify(input) + '\n')
    }

    child.once('error', failConnection)
    child.once('exit', failConnection)
    child.stdin.on('error', failConnection)
    lines.on('line', (line) => {
      const reply = parseReply(line)
      if (!reply || settled) return
      if (reply.id === 1) {
        if (reply.error || !reply.result) {
          fail(new CodexLaunchError('此 Codex 版本无法初始化额度接口。'))
          return
        }
        initialized = true
        clearTimeout(timeout)
        timeout = setTimeout(() => fail(new Error('读取 Codex 额度超时，请重试。')), 12_000)
        send({ method: 'initialized' })
        send({ id: 2, method: 'account/rateLimits/read' })
      }
      if (reply.id !== 2) return
      if (reply.error?.code === -32601) {
        fail(new CodexLaunchError('此 Codex 版本不支持额度查询。'))
        return
      }
      if (reply.error || !reply.result) {
        const message = reply.error?.message ?? ''
        fail(new Error(/auth|log.?in|signed.?in|401/i.test(message)
          ? '请在本机 Codex 中登录 ChatGPT，再刷新额度。'
          : 'Codex 暂未返回额度，请稍后重试。'))
        return
      }
      cleanup()
      resolve(parseCodexQuota(reply.result))
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'margin', title: 'Margin', version: app.getVersion() } } })
  })
}

function parseReply(line: string): {
  id?: number
  result?: Parameters<typeof parseCodexQuota>[0]
  error?: { code?: number; message?: string }
} | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

export async function readCodexQuota(): Promise<CodexQuota> {
  let found = false
  for await (const executable of codexExecutables()) {
    found = true
    try {
      return await queryCodexQuota(executable)
    } catch (error) {
      if (!(error instanceof CodexLaunchError)) throw error
    }
  }
  throw new Error(found
    ? '找到了 Codex，但无法启动额度查询。请更新 Codex，或打开 ChatGPT 用量。'
    : '未找到可用的 Codex。请安装 Codex 桌面版或 CLI 并登录，或打开 ChatGPT 用量。')
}

interface TokenRates {
  cacheHit: number
  cacheMiss: number
  output: number
}

// Official off-peak prices per million tokens. Peak prices are double these rates.
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// https://api-docs.deepseek.com/quick_start/pricing/
const deepSeekRates = {
  flash: {
    CNY: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    USD: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }
  },
  pro: {
    CNY: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    USD: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }
  }
}
const beijingOffsetMs = 8 * 3_600_000

function estimateDeepSeekCost(model: string, usage: ApiUsage, timestamp: number): DeepSeekQuota['today']['estimatedCost'] | null {
  const rates = model === 'deepseek-v4-pro' ? deepSeekRates.pro
    : ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model) ? deepSeekRates.flash : null
  const { promptTokens, completionTokens, cachedPromptTokens } = usage
  if (!rates || ![promptTokens, completionTokens].every((count) => Number.isFinite(count) && count >= 0)) return null
  const cached = typeof cachedPromptTokens === 'number' && Number.isFinite(cachedPromptTokens) &&
    cachedPromptTokens >= 0 && cachedPromptTokens <= promptTokens ? cachedPromptTokens : undefined
  const beijingTime = new Date(timestamp + beijingOffsetMs)
  const day = beijingTime.getUTCDay()
  const hour = beijingTime.getUTCHours()
  // A weekday in a peak window may be a public holiday. Show both tariffs in that case.
  const possiblePeak = day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
  function estimate({ cacheHit, cacheMiss, output }: TokenRates): CostRange {
    const inputCost = (hits: number) => hits * cacheHit + (promptTokens - hits) * cacheMiss
    const outputCost = completionTokens * output
    return {
      min: (inputCost(cached ?? promptTokens) + outputCost) / 1_000_000,
      max: (inputCost(cached ?? 0) + outputCost) / 1_000_000 * (possiblePeak ? 2 : 1)
    }
  }
  return { CNY: estimate(rates.CNY), USD: estimate(rates.USD) }
}

export async function deepSeekToday(logDir: string, providerId: string, timestamp = Date.now()): Promise<DeepSeekQuota['today']> {
  const day = 86_400_000
  const start = Math.floor((timestamp + beijingOffsetMs) / day) * day - beijingOffsetMs
  const end = start + day
  const logs = await readRequestLogs(logDir, Infinity, start, end)
  const today: DeepSeekQuota['today'] = {
    requests: 0,
    tokens: 0,
    estimatedCost: { CNY: { min: 0, max: 0 }, USD: { min: 0, max: 0 } },
    unpricedRequests: 0
  }
  for (const log of logs) {
    if (log.providerId !== providerId || !log.usage || !Number.isFinite(log.usage.totalTokens) || log.usage.totalTokens < 0) continue
    today.requests++
    today.tokens += log.usage.totalTokens
    const estimate = estimateDeepSeekCost(log.model, log.usage, log.createdAt)
    if (!estimate) {
      today.unpricedRequests++
      continue
    }
    for (const currency of ['CNY', 'USD'] as const) {
      today.estimatedCost[currency].min += estimate[currency].min
      today.estimatedCost[currency].max += estimate[currency].max
    }
  }
  return today
}

export async function readDeepSeekBalance(key: string): Promise<DeepSeekQuota['balances']> {
  const response = await net.fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(12_000)
  })
  if (!response.ok) throw new Error(`余额查询失败（HTTP ${response.status}）。`)
  const body = await response.json() as { balance_infos?: Array<{ currency?: string; total_balance?: string }> }
  if (!Array.isArray(body.balance_infos)) throw new Error('DeepSeek 未返回余额。')
  return body.balance_infos.flatMap(({ currency, total_balance: total }) =>
    typeof currency === 'string' && typeof total === 'string' ? [{ currency, total }] : [])
}
