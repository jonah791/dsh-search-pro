/**
 * 情报源 URL 的相对日期占位符（`{days:N}`）。
 *
 * 台账 lh-6890ff86：URL 里写死绝对日期会随窗口滑出而静默变死源——
 * 扫描照报 ok，只是量的是过去。这里测的是「折算对不对」，
 * **不是**「字段加上了没有」（加字段而不接消费点，是本项目踩过的坑，见 intel-scan.ts L235）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRelativeDates } from '../lib/intel-scan.js'

/** 固定时钟：2026-11-03 09:00 +08 = 01:00Z */
const NOW = new Date('2026-11-03T01:00:00Z')

const ABS_GITHUB =
  'https://api.github.com/search/repositories?q=created:%3E2026-10-27+topic:llm+stars:%3E50&sort=stars&order=desc&per_page=20'
const TPL_GITHUB =
  'https://api.github.com/search/repositories?q=created:%3E{days:7}+topic:llm+stars:%3E50&sort=stars&order=desc&per_page=20'

test('★ 等效性：占位符折算后必须逐字符等于今天线上的绝对 URL', () => {
  // 这是全套里最能区分新旧的一条：改前 lib 里没有这个函数，改后行为必须与手工改日期完全一致。
  assert.equal(resolveRelativeDates(TPL_GITHUB, NOW), ABS_GITHUB)
})

test('★ {days:7} 折算成 7 天前的 UTC 日期', () => {
  assert.equal(resolveRelativeDates('x?created:%3E{days:7}', NOW), 'x?created:%3E2026-10-27')
})

test('★ 无占位符原样返回（线上 9 个不含占位符的源零行为变化）', () => {
  const u = 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20'
  assert.equal(resolveRelativeDates(u, NOW), u)
})

test('{days:0} = 当天（UTC）', () => {
  assert.equal(resolveRelativeDates('d={days:0}', NOW), 'd=2026-11-03')
})

test('多个占位符各自展开', () => {
  assert.equal(resolveRelativeDates('a={days:1}&b={days:30}', NOW), 'a=2026-11-02&b=2026-10-04')
})

test('★ 非法写法原样保留（不静默兜底成"差不多"的日期）', () => {
  // 静默兜底会把「配置错误」变成「数据错误」——后者更难发现，且会污染台账。
  assert.equal(resolveRelativeDates('d={days:abc}', NOW), 'd={days:abc}')
  assert.equal(resolveRelativeDates('d={days:}', NOW), 'd={days:}')
  assert.equal(resolveRelativeDates('d={days:-1}', NOW), 'd={days:-1}')
  assert.equal(resolveRelativeDates('d={days:9999}', NOW), 'd={days:9999}')
})

test('残缺分隔符原样（不吞掉半个 URL）', () => {
  assert.equal(resolveRelativeDates('d={days:7', NOW), 'd={days:7')
  assert.equal(resolveRelativeDates('d=days:7}', NOW), 'd=days:7}')
})

test('对照：URL 里已存在的绝对日期不被误改', () => {
  const u = 'q=created:%3E2026-10-27&since=2026-01-01'
  assert.equal(resolveRelativeDates(u, NOW), u)
})

test('跨月边界', () => {
  assert.equal(resolveRelativeDates('d={days:3}', new Date('2026-01-02T00:00:00Z')), 'd=2025-12-30')
})

test('口径暴露：UTC 折算在本地凌晨会偏 1 天（这是已知且可接受的边界）', () => {
  // 本地 2026-11-03 00:30 (+08) = 2026-11-02T16:30Z ⇒ 减 7 天得 10-26 而非 10-27。
  // 取 UTC 是为了与 GitHub / arXiv 的日期过滤口径一致；偏 1 天在「最近 7 天」的用途上无害。
  assert.equal(resolveRelativeDates('{days:7}', new Date('2026-11-02T16:30:00Z')), '2026-10-26')
})
