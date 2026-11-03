/**
 * intel_digest 展示视图测试（纯函数，零 IO）。
 *
 * 存在理由（2026-11-03 线上实测）：`intel_digest` 报「new 合计 884」时，
 * `api-binance-delisting`——我专门标了 ★「提前 18 天公告、下架即暴跌」的最强信源，
 * 每 30 分钟扫一次——**显示 0/2**，17 天来一条都没进过 digest。
 *
 * 根因是三处截断叠在一起：
 *   `listItems({limit:500})` 全局按 foundAt 截断 → `rank()` 按价值排序 → 每目标 perTarget
 * 而 **`rank()` 排在全局截断之后** ⇒ 被截掉的条目根本没机会参与「按价值排」。
 * 884 条 new 里 arxiv-cs-ai 占 827 条，取前 500 时它吃掉 462 个名额，剩 38 个分给 9 个定向源。
 *
 * ⚠ 这些测试**不能**证明「线上不再饿死小源」——那取决于调用方传 `limit: 0`（全量）。
 * 第 1 条测的正是「传裁决断的后果」，第 2 条测「传全量的保证」：两条合起来才是完整判据。
 * 只测第 2 条会造出一种假安全——纯函数永远「正确」，而事故发生在它的上游。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildDigestView } from '../lib/intel.js'

const mk = (targetId, kind, i, publishedAt) => ({
  id: `${targetId}#${i}`,
  targetId,
  url: `https://x/${targetId}/${i}`,
  kind,
  title: `${targetId}-${i}`,
  foundAt: '2026-11-03T00:00:00.000Z',
  ...(publishedAt ? { publishedAt } : {}),
  status: 'new',
})

const TARGETS = [
  { id: 'arxiv-cs-ai', kind: 'arxiv' },
  { id: 'api-binance-delisting', kind: 'api' },
]

test('★尸体：调用方先截断 ⇒ 小源整个消失（这就是「0/2」的成因）', () => {
  // 模拟旧代码 `listItems({limit:500})` 按 foundAt 取前 500 条：arxiv 900 条把它吃光，
  // 定向源的 2 条压根没进 items。下游再怎么排都救不回来 —— 修复必须在上游。
  const items = Array.from({ length: 500 }, (_, i) => mk('arxiv-cs-ai', 'paper', i))
  const v = buildDigestView(items, TARGETS, 10)
  assert.equal(v.groups.has('api-binance-delisting'), false, '没进 items 的源不可能被分组出来')
  assert.equal(v.shown, 10, '只有 arxiv 有东西可列')
  assert.equal(v.autoCount, 500)
})

test('★传全量：一个源 900 条不得饿死另一个源的 2 条', () => {
  const items = [
    ...Array.from({ length: 900 }, (_, i) => mk('arxiv-cs-ai', 'paper', i)),
    mk('api-binance-delisting', 'api', 0, '2026-11-03T08:00:00.000Z'),
    mk('api-binance-delisting', 'api', 1, '2026-11-03T07:00:00.000Z'),
  ]
  const v = buildDigestView(items, TARGETS, 10)
  assert.equal(v.groups.get('api-binance-delisting').length, 2, '小源两条都必须在')
  assert.equal(v.groups.get('arxiv-cs-ai').length, 10, '大源受 perTarget 限制')
  assert.equal(v.shown, 12)
})

test('★clipped：被 perTarget 截的目标必须点名（「显示 2 条」≠「只有 2 条」）', () => {
  const items = [
    ...Array.from({ length: 900 }, (_, i) => mk('arxiv-cs-ai', 'paper', i)),
    mk('api-binance-delisting', 'api', 0),
  ]
  const v = buildDigestView(items, TARGETS, 10)
  assert.deepEqual(v.clipped, [['arxiv-cs-ai', 900]], '被截的是 arxiv，缺口数要精确到全量')
  // 对照组：没被截的目标不得出现——否则 clipped 恒非空，读数就没有分辨力
  assert.ok(!v.clipped.some(([tid]) => tid === 'api-binance-delisting'))
})

test('★clipped 对照组：没有任何目标超限时必须为空', () => {
  const items = [mk('arxiv-cs-ai', 'paper', 0), mk('api-binance-delisting', 'api', 1)]
  assert.deepEqual(buildDigestView(items, TARGETS, 10).clipped, [])
})

test('★autoCount：arxiv 自动入库与定向源必须分域（884 = 837 + 47）', () => {
  const items = [
    ...Array.from({ length: 30 }, (_, i) => mk('arxiv-cs-ai', 'paper', i)),
    ...Array.from({ length: 2 }, (_, i) => mk('api-binance-delisting', 'api', i)),
  ]
  const v = buildDigestView(items, TARGETS, 999)
  assert.equal(v.autoCount, 30, 'arxiv 源条数')
  assert.equal(v.ranked.length - v.autoCount, 2, '剩余即定向源——两者相加必须等于全量')
})

test('★rank 生效于 perTarget 之前：页面不得挤掉同目标的公告', () => {
  // 同一目标 12 条 page + 2 条 api，perTarget=3。
  // 若排序排在截断之后（或压根不排），page 会先占满 3 格 ⇒ 公告一条看不到。
  const items = [
    ...Array.from({ length: 12 }, (_, i) => mk('site-x', 'page', i, '2026-11-03T09:00:00.000Z')),
    mk('site-x', 'api', 100, '2026-11-03T01:00:00.000Z'),
    mk('site-x', 'api', 101, '2026-11-03T00:00:00.000Z'),
  ]
  const v = buildDigestView(items, [{ id: 'site-x', kind: 'site' }], 3)
  const got = v.groups.get('site-x').map((i) => i.kind)
  assert.deepEqual(got, ['api', 'api', 'page'], `公告必须先于页面进前 3，实际 ${got}`)
})

test('highShown 只数论文/公告/附件，页面不计（类型判据 ≠ 阅读价值）', () => {
  const items = [
    mk('site-x', 'page', 0),
    mk('site-x', 'page', 1),
    mk('site-x', 'api', 2),
    mk('site-x', 'attachment', 3),
  ]
  const v = buildDigestView(items, [{ id: 'site-x', kind: 'site' }], 10)
  assert.equal(v.shown, 4)
  assert.equal(v.highShown, 2, 'page 不计入 highShown——它量的是 kind，不是读不读')
})
