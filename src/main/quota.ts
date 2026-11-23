import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { app, net } from 'electron'
import type { ApiUsage, CodexQuota, CostRange, DeepSeekQuota, QuotaWindow } from '../shared/types'
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

export async function readCodexQuota(): Promise<CodexQuota> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex.exe', ['app-server', '--listen', 'stdio://'], {
      cwd: tmpdir(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const lines = createInterface({ input: child.stdout })
    function cleanup(): void {
      clearTimeout(timeout)
      lines.close()
      child.kill()
    }
    function fail(message: string): void {
      cleanup()
      reject(new Error(message))
    }
    function send(input: object): void {
      child.stdin.write(JSON.stringify(input) + '\n')
    }
    const timeout = setTimeout(() => fail('读取 Codex 额度超时，请重试。'), 12_000)
    child.once('error', () => fail('找不到 Codex CLI。请在 ChatGPT 用量页面查看。'))
    child.once('exit', () => fail('Codex 退出，未返回额度。'))
    child.stdin.on('error', () => fail('无法连接 Codex CLI。'))
    lines.on('line', (line) => {
      try {
        const reply = JSON.parse(line)
        if (reply.id === 1) {
          if (reply.error) return fail('Codex 额度接口初始化失败。')
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read' })
        }
        if (reply.id !== 2) return
        if (reply.error || !reply.result) return fail('无法读取额度。请确认 Codex 已用 ChatGPT 账号登录。')
        const quota = parseCodexQuota(reply.result)
        cleanup()
        resolve(quota)
      } catch {
        fail('Codex 返回了无法读取的额度响应。')
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'margin', title: 'Margin', version: app.getVersion() } } })
  })
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
