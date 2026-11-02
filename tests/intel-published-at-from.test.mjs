/**
 * `publishedAtFrom`：让时间来源可信度到达读者（2026-11-03 · t-aeb619c7）。
 *
 * 存在理由：`discoverSite` 的 `times` 一直带 `from` 标注（meta / time-tag / url / page），
 * 但 `intel-scan` 的 `timeOf()` 只把 `at` 透成 `publishedAt`，**丢掉 `from`**
 * ⇒ 来源可信度止于中间层，读者分不清「源说的」和「我推的」。
 *
 * 本文件的判据即任务写死的四条，外加两条回归护栏：
 * ① 新条目带上 publishedAtFrom
 * ② 渲染能区分 meta 与 page
 * ③ 存量条目不受影响（无来源时按直接信号显示，不报错）
 * ④ **尸体**：无 publishedAt 的条目不得出现 publishedAtFrom（含渲染侧）
 * ⑤ 尸体：来源未知时**不补造**标记
 * ⑥ 回归：ageLabel 原签名不变（第二参仍是 now）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ageLabel, ageLabelWithSource, normalizeItem, pickBackfill } from '../lib/intel.js'

const NOW = new Date('2026-11-03T00:00:00.000Z').getTime()

/** 造一条「10 小时前发布」的条目输入 */
const baseInput = {
  url: 'https://example.com/a',
  targetId: 't-1',
  now: '2026-11-03T00:00:00.000Z',
}

// ── 判据①：新条目带上来源 ──────────────────────────────────────────────
test('① normalizeItem：有 publishedAtFrom ⇒ 条目带上它', () => {
  const it = normalizeItem({
    ...baseInput,
    publishedAt: '2026-11-02T14:00:00.000Z',
    publishedAtFrom: 'meta',
  })
  assert.equal(it.publishedAt, '2026-11-02T14:00:00.000Z')
  assert.equal(it.publishedAtFrom, 'meta')
})

test('① 四种来源都能原样落盘（不归一、不改写）', () => {
  for (const from of ['meta', 'time-tag', 'url', 'page']) {
    const it = normalizeItem({ ...baseInput, url: `https://example.com/${from}`, publishedAt: '2026-11-02T14:00:00.000Z', publishedAtFrom: from })
    assert.equal(it.publishedAtFrom, from, `来源 ${from} 被改写了`)
  }
})

// ── 判据④（尸体）：无时间 ⇒ 不得有来源 ─────────────────────────────────
test('★ 尸体④：没有 publishedAt 时，即使传了 publishedAtFrom 也**不得**落盘', () => {
  const it = normalizeItem({ ...baseInput, publishedAtFrom: 'page' })
  assert.equal('publishedAtFrom' in it, false,
    '没有时间却带上了来源——来源描述的是「那个时间」，没有时间就没有被描述的对象')
})

test('★ 尸体④（渲染侧）：无 publishedAt ⇒ 显示「时间未知」，且不带任何来源标记', () => {
  for (const from of ['meta', 'time-tag', 'url', 'page', undefined]) {
    const s = ageLabelWithSource(undefined, from, NOW)
    assert.equal(s, '时间未知', `来源 ${String(from)} 污染了「时间未知」：${s}`)
  }
})

// ── 判据②：渲染能区分 meta 与 page ────────────────────────────────────
test('② ageLabelWithSource：page（代理量）带 ≈，meta（直接信号）不带标记', () => {
  const at = '2026-11-02T14:00:00.000Z' // 10h 前
  const meta = ageLabelWithSource(at, 'meta', NOW)
  const page = ageLabelWithSource(at, 'page', NOW)
  const url = ageLabelWithSource(at, 'url', NOW)

  assert.equal(meta, ageLabel(at, NOW), 'meta 是直接信号，不该加标记')
  assert.notEqual(meta, page, 'meta 与 page 渲染成同一个样子 ⇒ 判据②没达成')
  assert.ok(page.startsWith('≈'), `page 应带代理量标记：${page}`)
  assert.ok(url.startsWith('~'), `url 应带路径日期段标记：${url}`)
  assert.ok(page.endsWith(ageLabel(at, NOW)), `标记不该吃掉时间本身：${page}`)
})

test('② time-tag 与未知来源都按直接信号显示（不补造标记）', () => {
  const at = '2026-11-02T14:00:00.000Z'
  const plain = ageLabel(at, NOW)
  assert.equal(ageLabelWithSource(at, 'time-tag', NOW), plain)
  assert.equal(ageLabelWithSource(at, undefined, NOW), plain, '来源未知时不得补造标记')
})

// ── 判据③：存量条目不受影响 ────────────────────────────────────────────
test('③ 存量条目（无 publishedAtFrom 字段）渲染不报错、按直接信号显示', () => {
  const legacy = { publishedAt: '2026-11-02T14:00:00.000Z' } // 老条目没有 from 字段
  const s = ageLabelWithSource(legacy.publishedAt, legacy.publishedAtFrom, NOW)
  assert.equal(s, ageLabel(legacy.publishedAt, NOW))
})

// ── 回填：from 与时间同进同退 ──────────────────────────────────────────
test('pickBackfill：新补时间的条目同时带出来源', () => {
  // 夹具必须用 normalizeItem 造 —— id 由 fingerprint(url) 决定，
  // 手写一个 id 会让 byId 查不到（我第一次就这么错了，测试挂了但代码是对的）
  const known = [normalizeItem({ ...baseInput })] // 已落盘但没时间
  const out = pickBackfill(
    [{ url: 'https://example.com/a', publishedAt: '2026-11-02T14:00:00.000Z', publishedAtFrom: 'page' }],
    known,
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].publishedAtFrom, 'page', '只补时间不补来源，会让这批被当成直接信号')
})

test('★ 幂等：已有 publishedAt 的条目不补（含不补来源）', () => {
  const known = [normalizeItem({ ...baseInput, publishedAt: '2026-11-01T00:00:00.000Z' })]
  const out = pickBackfill(
    [{ url: 'https://example.com/a', publishedAt: '2026-11-02T14:00:00.000Z', publishedAtFrom: 'meta' }],
    known,
  )
  assert.equal(out.length, 0, '已有时间的条目被重复补写——后写胜语义会污染事件流')
})

// ── 回归护栏：ageLabel 第二参仍是 now ─────────────────────────────────
test('回归：ageLabel(publishedAt, now) 的语义未被改动', () => {
  assert.equal(ageLabel(undefined, NOW), '时间未知')
  assert.equal(ageLabel('not-a-date', NOW), '时间未知')
  assert.equal(ageLabel('2026-11-02T14:00:00.000Z', NOW), '10.0h 前')
})
