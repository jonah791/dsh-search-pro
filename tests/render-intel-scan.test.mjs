/**
 * 扫描读数渲染测试（纯函数，零网络）。
 *
 * 存在理由（2026-10-17 **第三次同型事故**）：`outcomes` 是**手写字段枚举**，
 * 于是新加的 `backfilled` **静默丢掉**——回填真的成功了（库里 20 条已带 publishedAt），
 * 读数里却只有「扫到 20 · 新增 0」。
 *
 * 本文件锁的是**结构性质**：outcome 必须**透传** ScanResult 的全部字段
 * （新增字段自动进读数），而不是靠「下次记得改两处」。
 * 判据有区分力：把 toOutcome 改回手写枚举，第 1 条立刻挂。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toOutcome, renderIntelScan } from '../lib/index.js'

test('★ toOutcome：透传全部字段（新增字段自动进读数——不许手写枚举）', () => {
  const r = {
    targetId: 't',
    state: 'ok',
    foundCount: 20,
    newCount: 0,
    backfilled: 20, // ← 今晚新加的字段（事故的当事人）
    elapsedMs: 300,
    items: [{ id: 'x' }],
  }
  const o = toOutcome(r)
  assert.equal(o.backfilled, 20, '新增字段被丢了——这就是那三次同型事故的形状')
  assert.equal(o.foundCount, 20)
  assert.equal(o.elapsedMs, 300)
  // items 必须排除（它已在顶层汇总，重复进 outcome 会让读数翻倍）
  assert.equal('items' in o, false)
})

test('★ toOutcome：未知字段也照传（未来的字段不必回来改这里）', () => {
  const o = toOutcome({ targetId: 't', state: 'ok', someFutureField: 'v', items: [] })
  assert.equal(o.someFutureField, 'v')
})

test('★ renderIntelScan：outcome 带 backfilled ⇒ 读数里出现「补写时间」', () => {
  const out = renderIntelScan(
    {},
    {
      ok: true,
      scanned: 1,
      okCount: 1,
      failedCount: 0,
      foundTotal: 20,
      newTotal: 0,
      outcomes: [{ targetId: 't', state: 'ok', foundCount: 20, newCount: 0, backfilled: 20, elapsedMs: 300 }],
      items: [],
      failures: [],
    },
  )
  const text = out.map((x) => x.text).join('\n')
  assert.match(text, /补写时间 20/)
})

test('★ 反向：没有 backfilled 的 outcome 不得显示「补写时间 0」（不产无中生有的读数）', () => {
  const out = renderIntelScan(
    {},
    {
      ok: true,
      scanned: 1,
      okCount: 1,
      failedCount: 0,
      foundTotal: 5,
      newTotal: 0,
      outcomes: [{ targetId: 't', state: 'ok', foundCount: 5, newCount: 0, elapsedMs: 100 }],
      items: [],
      failures: [],
    },
  )
  const text = out.map((x) => x.text).join('\n')
  assert.doesNotMatch(text, /补写时间/)
})

test('★ renderIntelScan：新增条目带时效标签（源侧时间必须在文本里看得见）', () => {
  const iso = new Date(Date.now() - 6 * 3600_000).toISOString()
  const out = renderIntelScan(
    {},
    {
      ok: true,
      scanned: 1,
      okCount: 1,
      failedCount: 0,
      foundTotal: 1,
      newTotal: 1,
      outcomes: [{ targetId: 't', state: 'ok', foundCount: 1, newCount: 1, elapsedMs: 50 }],
      items: [{ id: 'x', kind: 'api', url: 'https://x/a', title: 'A', publishedAt: iso }],
      failures: [],
    },
  )
  const text = out.map((x) => x.text).join('\n')
  assert.match(text, /6\.0h 前/)
})

test('★ renderIntelScan：条目无 publishedAt ⇒ 显示「时间未知」（不是「刚发布」）', () => {
  const out = renderIntelScan(
    {},
    {
      ok: true,
      scanned: 1,
      okCount: 1,
      failedCount: 0,
      foundTotal: 1,
      newTotal: 1,
      outcomes: [{ targetId: 't', state: 'ok', foundCount: 1, newCount: 1, elapsedMs: 50 }],
      items: [{ id: 'x', kind: 'api', url: 'https://x/a', title: 'A' }],
      failures: [],
    },
  )
  const text = out.map((x) => x.text).join('\n')
  assert.match(text, /时间未知/)
})
