import { stat } from 'node:fs/promises'
import { parse } from 'csv-parse/sync'
import { openPromise } from 'yauzl'
import type { DeepSeekUsageReport } from '../shared/types'

const maxArchiveSize = 12 * 1024 * 1024
const maxCsvSize = 16 * 1024 * 1024
const moneyPrecision = 24
const moneyScale = 10n ** BigInt(moneyPrecision)
type UsageTable = 'cost' | 'amount'

export class DeepSeekUsageError extends Error {}

function readCsv(text: string, required: string[]) {
  const [header, ...rows] = parse(text, {
    bom: true, skip_empty_lines: true, trim: true, max_record_size: 16_384
  }) as string[][]
  const dateColumn = header?.includes('start_time_iso') ? 'start_time_iso' : 'utc_date'
  if (!header || new Set(header).size !== header.length ||
      ![dateColumn, ...required].every((column) => header.includes(column))) {
    throw new DeepSeekUsageError('DeepSeek 用量表的列格式无法识别。请从官网重新导出 ZIP。')
  }
  return { rows, header, dateColumn }
}

function readDate(value: string): string {
  const date = /^\d{4}-\d{2}-\d{2}(?=$|T| )/.exec(value)?.[0]
  const timestamp = date ? Date.parse(date) : NaN
  if (!date || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new DeepSeekUsageError('DeepSeek 用量表包含无效日期。')
  }
  return date
}

function readMoney(value: string): bigint {
  const match = /^([+-]?)(\d{1,24})(?:\.(\d{1,24}))?(?:e([+-]?\d{1,2}))?$/i.exec(value)
  if (!match) throw new DeepSeekUsageError('DeepSeek 费用表包含无效金额。')
  const [, sign, whole, fraction = '', exponent = '0'] = match
  const scale = moneyPrecision - fraction.length + Number(exponent)
  if (scale < 0 || scale > 2 * moneyPrecision) throw new DeepSeekUsageError('DeepSeek 费用表包含超出支持精度的金额。')
  const units = BigInt(whole + fraction) * 10n ** BigInt(scale)
  return sign === '-' ? -units : units
}

function formatMoney(units: bigint): string {
  const negative = units < 0n
  const value = negative ? -units : units
  const fraction = (value % moneyScale).toString().padStart(moneyPrecision, '0')
    .replace(/0+$/, '').padEnd(2, '0')
  return `${negative ? '-' : ''}${value / moneyScale}.${fraction}`
}

function readTokenCount(value: string): bigint {
  if (!/^\d{1,24}$/.test(value)) throw new DeepSeekUsageError('DeepSeek 用量表包含无效的 Token 数。')
  return BigInt(value)
}

export function summarizeDeepSeekUsage(costCsv: string, amountCsv: string, importedAt = Date.now()): DeepSeekUsageReport {
  const cost = readCsv(costCsv, ['cost', 'currency'])
  const amount = readCsv(amountCsv, ['type', 'amount'])
  if (cost.dateColumn !== amount.dateColumn) throw new DeepSeekUsageError('DeepSeek 费用表和用量表的日期格式不一致。')

  const days = new Map<string, { costs: Map<string, bigint>; hit: bigint; miss: bigint }>()
  function usageForDate(value: string) {
    const date = readDate(value)
    if (days.size >= 370 && !days.has(date)) throw new DeepSeekUsageError('请选择跨度不超过一年的 DeepSeek 用量导出。')
    const day = days.get(date) ?? { costs: new Map<string, bigint>(), hit: 0n, miss: 0n }
    days.set(date, day)
    return day
  }

  const costDateIndex = cost.header.indexOf(cost.dateColumn)
  const currencyIndex = cost.header.indexOf('currency')
  const costIndex = cost.header.indexOf('cost')
  for (const row of cost.rows) {
    const { costs } = usageForDate(row[costDateIndex])
    const currency = row[currencyIndex].toUpperCase()
    if (currency !== 'CNY' && currency !== 'USD') throw new DeepSeekUsageError('DeepSeek 费用表包含不支持的币种。')
    costs.set(currency, (costs.get(currency) ?? 0n) + readMoney(row[costIndex]))
  }

  const amountDateIndex = amount.header.indexOf(amount.dateColumn)
  const typeIndex = amount.header.indexOf('type')
  const amountIndex = amount.header.indexOf('amount')
  for (const row of amount.rows) {
    const day = usageForDate(row[amountDateIndex])
    if (row[typeIndex] === 'input_cache_hit_tokens') day.hit += readTokenCount(row[amountIndex])
    if (row[typeIndex] === 'input_cache_miss_tokens') day.miss += readTokenCount(row[amountIndex])
  }
  if (!days.size) throw new DeepSeekUsageError('这份 DeepSeek 导出中没有用量记录。')

  return {
    importedAt,
    dateBasis: cost.dateColumn === 'utc_date' ? 'UTC' : 'export',
    days: [...days.keys()].sort().reverse().map((date) => {
      const { costs, hit, miss } = days.get(date)!
      const input = hit + miss
      return {
        date,
        costs: [...costs].sort(([left], [right]) => left.localeCompare(right))
          .map(([currency, total]) => ({ currency, total: formatMoney(total) })),
        cacheHitRate: input > 0n ? Number(hit) / Number(input) : null
      }
    })
  }
}

export async function importDeepSeekUsage(filePath: string): Promise<DeepSeekUsageReport> {
  const file = await stat(filePath)
  if (!file.isFile() || file.size > maxArchiveSize) throw new DeepSeekUsageError('请选择 12 MB 以内的 DeepSeek 官网 ZIP 导出。')

  const zip = await openPromise(filePath, { autoClose: false })
  const tables = new Map<UsageTable, { range: string; text: string }>()
  try {
    if (zip.entryCount > 64) throw new DeepSeekUsageError('ZIP 内的文件过多。请选择 DeepSeek 官网导出的原始 ZIP。')
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName.split('/').at(-1) ?? ''
      const match = /^(cost|amount)-(.+)\.csv$/i.exec(name)
      if (!match) continue
      const table = match[1].toLowerCase() as UsageTable
      if (tables.has(table) || entry.uncompressedSize > maxCsvSize) {
        throw new DeepSeekUsageError('用量表重复或过大。请选择一份较短时间范围的 DeepSeek 导出。')
      }
      const stream = await zip.openReadStreamPromise(entry)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(chunk as Buffer)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      tables.set(table, { range: match[2], text })
    }
  } finally {
    zip.close()
  }

  const cost = tables.get('cost')
  const amount = tables.get('amount')
  if (!cost || !amount || cost.range !== amount.range) {
    throw new DeepSeekUsageError('ZIP 必须包含同一时段的 DeepSeek 费用表和用量表。')
  }
  return summarizeDeepSeekUsage(cost.text, amount.text)
}
