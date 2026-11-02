/**
 * `api` 源的 `maxItems` 上界与 `rawCount` 读数（2026-11-03 · t-df1b9eeb）。
 *
 * 存在理由：`isIntelWorthy` 对 `source === 'api'` 一律放行（不受基线判据限制）——
 * 这在**小端点**上是对的（币安/OKX 各 20 条公告，首扫全收正是想要的），
 * 但**大端点会灌全量**。实测 Coinbase `api.exchange.coinbase.com/products`
 * （交易对列表，根数组 300+ 条）若接入，首扫会一次性入库 300+ 条存量。
 *
 * 缺口在于一个等式被当成了事实：**「声明式精选」≠「端点小」**。
 * itemsPath 指向的确实是目标集合，但集合的大小与信噪比无关。
 *
 * 本文件的判据：
 * ① 配了 maxItems ⇒ 截断，且 **truncated / rawCount 必须如实报**
 * ② 「端点给了 N 条」与「我收下 M 条」在读数上**必须可分辨**（防大端点看起来很小）
 * ③ 不配 maxItems ⇒ 行为与旧版逐字节一致（不破坏既有 7 个源）
 * ④ 尸体：取不到数组时 rawCount 记 0 且 errors 有话要说（不许静默成「0 条」）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mapApiItems } from '../lib/intel-api.js'

/** 造一个「N 条、结构正常」的声明式端点响应 */
function endpoint(n) {
  return {
    data: {
      items: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, title: `公告 ${i}` })),
    },
  }
}

const spec = { url: 'https://api.example.com/x', itemsPath: 'data.items', urlTemplate: 'https://example.com/{id}' }

// ── 判据③：不配 maxItems ⇒ 与旧行为一致 ──────────────────────────────
test('③ 不配 maxItems ⇒ 全收，且不出现 truncated', () => {
  const r = mapApiItems(endpoint(5), spec)
  assert.equal(r.items.length, 5)
  assert.equal(r.rawCount, 5)
  assert.equal('truncated' in r, false, '没截断却报了 truncated')
  assert.equal(r.errors.length, 0)
})

// ── 判据①：截断 + 如实报 ─────────────────────────────────────────────
test('① 配 maxItems=2 且有 5 条 ⇒ 收 2 条，truncated=3，rawCount=5', () => {
  const r = mapApiItems(endpoint(5), { ...spec, maxItems: 2 })
  assert.equal(r.items.length, 2)
  assert.equal(r.truncated, 3)
  assert.equal(r.rawCount, 5)
  assert.ok(r.notes.some((n) => n.includes('截断')), `截断必须进 notes：${JSON.stringify(r.notes)}`)
  assert.ok(r.notes.some((n) => n.includes('丢 3')), `要报丢了多少条：${JSON.stringify(r.notes)}`)
})

// ── 判据②：两个数必须可分辨 ──────────────────────────────────────────
test('★ 判据②：截断后 items.length ≠ rawCount——「端点 300 条」不能看起来像「只有 20 条」', () => {
  const r = mapApiItems(endpoint(300), { ...spec, maxItems: 20 })
  assert.equal(r.items.length, 20)
  assert.equal(r.rawCount, 300, 'rawCount 丢了 ⇒ 大端点会被误判成小端点，下次也没人知道要配 maxItems')
  assert.notEqual(r.items.length, r.rawCount)
})

// ── 边界 ──────────────────────────────────────────────────────────────
test('maxItems 大于总数 ⇒ 不截断（上界不是「取前 N 条」）', () => {
  const r = mapApiItems(endpoint(3), { ...spec, maxItems: 100 })
  assert.equal(r.items.length, 3)
  assert.equal('truncated' in r, false)
})

test('maxItems=0 ⇒ 全部截掉（0 是合法上界，不是「不限制」）', () => {
  const r = mapApiItems(endpoint(4), { ...spec, maxItems: 0 })
  assert.equal(r.items.length, 0)
  assert.equal(r.truncated, 4)
  assert.equal(r.rawCount, 4)
})

// ── 判据④（尸体）：取不到数组不许静默成「0 条」 ───────────────────────
test('★ 尸体④：itemsPath 取不到 ⇒ rawCount=0 且 errors 有话说（不是静默 0 条）', () => {
  const r = mapApiItems({ data: {} }, spec)
  assert.equal(r.rawCount, 0)
  assert.ok(r.errors.length > 0, '「0 条」与「路径配置错了」必须分型')
})

test('★ 尸体④：itemsPath 指向非数组 ⇒ 同样 errors 有话', () => {
  const r = mapApiItems({ data: { items: 'not-an-array' } }, spec)
  assert.equal(r.rawCount, 0)
  assert.ok(r.errors.length > 0)
  assert.ok(r.errors[0].includes('不是数组'), r.errors[0])
})

// ── 截断不改变「跳过/时间失败」的统计口径 ────────────────────────────
test('截断后 skipped / 时间失败的统计仍按**全量**报（如实）', () => {
  // 5 条里 1 条缺 id（会被跳过）⇒ 收 4 条，再按 maxItems=2 截断
  const json = {
    data: {
      items: [
        { id: 'a' }, { title: '没有 id' }, { id: 'c' }, { id: 'd' }, { id: 'e' },
      ],
    },
  }
  const r = mapApiItems(json, { ...spec, maxItems: 2 })
  assert.equal(r.items.length, 2)
  assert.equal(r.skipped, 1)
  assert.equal(r.rawCount, 5)
  assert.ok(r.notes.some((n) => n.includes('跳过 1/5')), `跳过统计口径被截断改变了：${JSON.stringify(r.notes)}`)
})
