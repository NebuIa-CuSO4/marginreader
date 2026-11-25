const assert = require('node:assert/strict')
const { test } = require('node:test')
const { summarizeDeepSeekUsage } = require('../src/main/deepSeekUsage.ts')

test('daily costs preserve official amounts and keep currencies separate', () => {
  const cost = [
    '\uFEFFstart_time_iso,model,wallet_type,cost,currency',
    '2026-11-24T00:00:00+08:00,flash,Paid,0.4,CNY',
    '2026-11-25T00:00:00+08:00,pro,Paid,0.1,CNY',
    '2026-11-25T00:00:00+08:00,pro,Granted,0.2,CNY',
    '2026-11-25T00:00:00+08:00,,Paid,4e-10,CNY',
    '2026-11-25T00:00:00+08:00,flash,Paid,0.75,USD'
  ].join('\r\n')
  const amount = [
    'start_time_iso,api_key_name,type,amount,price',
    '2026-11-25T00:00:00+08:00,"one, personal",input_cache_hit_tokens,300,0.03',
    '2026-11-25T00:00:00+08:00,two,input_cache_miss_tokens,100,0.2',
    '2026-11-25T00:00:00+08:00,two,output_tokens,999,0.4',
    '2026-11-25T00:00:00+08:00,two,function_call,200,0.005'
  ].join('\r\n')
  assert.deepEqual(summarizeDeepSeekUsage(cost, amount, 123), {
    importedAt: 123,
    dateBasis: 'export',
    days: [
      { date: '2026-11-25', costs: [{ currency: 'CNY', total: '0.3000000004' }, { currency: 'USD', total: '0.75' }], cacheHitRate: 0.75 },
      { date: '2026-11-24', costs: [{ currency: 'CNY', total: '0.40' }], cacheHitRate: null }
    ]
  })
})

test('legacy UTC exports distinguish zero hit rate from unavailable cost', () => {
  const cost = 'utc_date,cost,currency\n2026-11-25,0,CNY'
  const amount = 'utc_date,type,amount\n2026-11-25,input_cache_miss_tokens,10\n2026-11-24,input_cache_miss_tokens,2'
  const result = summarizeDeepSeekUsage(cost, amount)
  assert.equal(result.dateBasis, 'UTC')
  assert.deepEqual(result.days, [
    { date: '2026-11-25', costs: [{ currency: 'CNY', total: '0.00' }], cacheHitRate: 0 },
    { date: '2026-11-24', costs: [], cacheHitRate: 0 }
  ])
})

test('incomplete or malformed exports do not return misleading official amounts', () => {
  const amount = 'utc_date,type,amount'
  assert.throws(() => summarizeDeepSeekUsage('utc_date,price,currency', amount), /列格式/)
  assert.throws(() => summarizeDeepSeekUsage('utc_date,cost,currency', amount), /没有用量记录/)
  assert.throws(() => summarizeDeepSeekUsage('utc_date,cost,currency\n2026-02-29,1,CNY', amount), /无效日期/)
  assert.throws(() => summarizeDeepSeekUsage('utc_date,cost,currency\n2026-11-25,invalid,CNY', amount), /无效金额/)
})
