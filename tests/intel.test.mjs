/**
 * 情报系统纯函数层测试。
 *
 * 核心判据是**增量**：同一目标连扫两次，第二次必须 0 条新增。
 * 本文件用纯函数直接验证这条判据的两个前提：指纹归一 + diffNew 正确。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  fingerprint,
  diffNew,
  classifyItem,
  isIntelWorthy,
  normalizeItem,
  intelStats,
  summarizeScans,
} from '../lib/intel.js'

// ── fingerprint ────────────────────────────────────────────────────────
test('fingerprint：http→https、去 hash、host 小写 归一到同一个 key', () => {
  const a = fingerprint('http://WWW.A.B/x#frag')
  const b = fingerprint('https://www.a.b/x')
  assert.equal(a, b, '同资源不同形态必须同指纹，否则增量判据失效')
  assert.equal(a, 'https://www.a.b/x')
})

test('fingerprint：query 保留（不同 query 是不同资源）', () => {
  assert.notEqual(fingerprint('https://a.b/x?id=1'), fingerprint('https://a.b/x?id=2'))
})

test('fingerprint：非法输入原样返回（不抛，不静默丢）', () => {
  assert.equal(fingerprint('not a url'), 'not a url')
  assert.equal(fingerprint('  spaced  '), 'spaced')
})

// ── diffNew（增量判据）─────────────────────────────────────────────────
test('diffNew：已知集合之外的才算新', () => {
  const known = [fingerprint('https://a.b/1'), fingerprint('https://a.b/2')]
  const found = [{ url: 'https://a.b/1' }, { url: 'https://a.b/2' }, { url: 'https://a.b/3' }]
  const fresh = diffNew(found, known)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].url, 'https://a.b/3')
})

test('diffNew：同一批里的重复只报一次（批内去重）', () => {
  const found = [{ url: 'https://a.b/x' }, { url: 'http://a.b/x#h' }, { url: 'https://a.b/y' }]
  assert.equal(diffNew(found, []).length, 2, 'x 的两种形态算一条')
})

test('★ 增量判据：连扫两次，第二次必须 0 条新增（本系统的分水岭）', () => {
  const found = [{ url: 'https://a.b/1' }, { url: 'https://a.b/2' }]
  const first = diffNew(found, [])
  assert.equal(first.length, 2, '首扫两条都是新的')
  // 把首扫结果记入已知（模拟快照更新）
  const known = first.map((f) => fingerprint(f.url))
  const second = diffNew(found, known)
  assert.equal(second.length, 0, '第二扫不许重复报')
})

test('diffNew：空输入是空（不是错误）', () => {
  assert.deepEqual(diffNew([], []), [])
  assert.deepEqual(diffNew([{ url: 'https://a.b/1' }], []).length, 1)
})

// ── classifyItem ───────────────────────────────────────────────────────
test('classifyItem：附件与网页分开；arxiv 源优先判为 paper', () => {
  assert.equal(classifyItem('https://a.b/x.pdf'), 'attachment')
  assert.equal(classifyItem('https://a.b/list.htm'), 'page')
  assert.equal(classifyItem('https://a.b/x', 'application/pdf'), 'attachment', '靠 mime 补漏判')
  assert.equal(classifyItem('https://arxiv.org/abs/2602.05975', undefined, 'arxiv'), 'paper')
})

// ── isIntelWorthy ──────────────────────────────────────────────────────
test('isIntelWorthy：站点协议文件不是情报', () => {
  assert.equal(isIntelWorthy('https://a.b/robots.txt'), false)
  assert.equal(isIntelWorthy('https://a.b/sitemap.xml'), false)
  assert.equal(isIntelWorthy('https://a.b/notice.pdf'), true)
  assert.equal(isIntelWorthy('/local/path'), false, '非 http 不进库')
})

// ── normalizeItem ──────────────────────────────────────────────────────
test('normalizeItem：同资源不同形态 ⇒ 同 id（幂等）', () => {
  const a = normalizeItem({ url: 'https://a.b/x', targetId: 't1', now: '2026-01-01T00:00:00Z' })
  const b = normalizeItem({ url: 'http://A.B/x#h', targetId: 't2', now: '2026-01-02T00:00:00Z' })
  assert.equal(a.id, b.id)
  assert.equal(a.url, b.url)
  assert.equal(a.status, 'new', '缺省状态是 new')
  assert.equal(a.kind, 'page')
})

test('normalizeItem：不产生 undefined 字段（DSH 要求无损 JSON）', () => {
  const it = normalizeItem({ url: 'https://a.b/x', targetId: 't1' })
  for (const [k, v] of Object.entries(it)) {
    assert.notEqual(v, undefined, `字段 ${k} 是 undefined`)
  }
})

test('normalizeItem：带 mime 时进 meta', () => {
  const it = normalizeItem({ url: 'https://a.b/x', targetId: 't1', mime: 'application/pdf' })
  assert.equal(it.kind, 'attachment')
  assert.equal(it.meta?.mime, 'application/pdf')
})

// ── intelStats / summarizeScans ────────────────────────────────────────
test('intelStats：按状态/类型/目标三维现算', () => {
  const items = [
    normalizeItem({ url: 'https://a.b/1', targetId: 't1' }),
    normalizeItem({ url: 'https://a.b/2.pdf', targetId: 't1' }),
    normalizeItem({ url: 'https://a.b/3', targetId: 't2', status: 'starred' }),
  ]
  const s = intelStats(items, [{ id: 't1' }, { id: 't2' }])
  assert.equal(s.total, 3)
  assert.equal(s.targets, 2)
  assert.equal(s.byKind.attachment, 1)
  assert.equal(s.byStatus.new, 2)
  assert.equal(s.byStatus.starred, 1)
  assert.equal(s.byTarget.t1, 2)
})

test('★ summarizeScans：0 条新增与扫描失败必须分型（不许都渲染成 0）', () => {
  const s = summarizeScans([
    { targetId: 'a', state: 'ok', foundCount: 10, newCount: 0, elapsedMs: 100 },
    { targetId: 'b', state: 'failed', foundCount: 0, newCount: 0, error: 'DNS 失败', elapsedMs: 50 },
  ])
  assert.equal(s.okCount, 1)
  assert.equal(s.failedCount, 1)
  assert.equal(s.newTotal, 0)
  assert.deepEqual(s.failedTargets, ['b'])
  assert.ok(s.failures[0].includes('DNS 失败'))
})

test('summarizeScans：全成功时 failedTargets 为空', () => {
  const s = summarizeScans([{ targetId: 'a', state: 'ok', foundCount: 5, newCount: 2, elapsedMs: 10 }])
  assert.equal(s.failedCount, 0)
  assert.deepEqual(s.failedTargets, [])
  assert.equal(s.newTotal, 2)
})

test('★ summarizeScans：部分源失败是第三态（与「成功」「失败」都不许互相掩盖）', () => {
  // 尸体样本 = 2026-10-16 线上实测的真实形状：
  // CC 返回 504，目标仍报 ok，扫到数 98→60 静默缩水——而读数里看不出「有源没答」
  const s = summarizeScans([
    { targetId: 'ok-pure', state: 'ok', foundCount: 10, newCount: 0, elapsedMs: 100 },
    {
      targetId: 'domain-sues', state: 'ok', foundCount: 60, newCount: 0, elapsedMs: 56708,
      partial: true, sourceErrors: ['commoncrawl: CC-MAIN-2026-39: HTTP 504'],
    },
    { targetId: 'dead', state: 'failed', foundCount: 0, newCount: 0, error: '全部源失败：x', elapsedMs: 10 },
  ])
  assert.equal(s.okCount, 2, 'partial 仍算 ok——它确实扫到了东西')
  assert.equal(s.failedCount, 1)
  assert.equal(s.partialCount, 1, 'partial 必须单独数出来，否则「源坏了」被读成「源没新的」')
  assert.deepEqual(s.partialTargets, ['domain-sues'])
  assert.equal(s.partialTargets.includes('ok-pure'), false, '纯 ok 不许被算成 partial')
  assert.ok(s.sourceErrors[0].includes('504'))
  assert.ok(s.sourceErrors[0].startsWith('domain-sues:'), '源错误必须带目标归属（否则不知道是谁坏了）')
})

test('summarizeScans：无 partial 时三个字段都是空值而非 undefined（防渲染层读到 undefined）', () => {
  const s = summarizeScans([{ targetId: 'a', state: 'ok', foundCount: 1, newCount: 1, elapsedMs: 5 }])
  assert.equal(s.partialCount, 0)
  assert.deepEqual(s.partialTargets, [])
  assert.deepEqual(s.sourceErrors, [])
})
