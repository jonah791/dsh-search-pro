/**
 * 情报系统纯函数层测试。
 *
 * 核心判据是**增量**：同一目标连扫两次，第二次必须 0 条新增。
 * 本文件用纯函数直接验证这条判据的两个前提：指纹归一 + diffNew 正确。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  fingerprint,
  diffNew,
  classifyItem,
  isStructuralPage,
  isHighValue,
  kindTag,
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

// ── isStructuralPage / isIntelWorthy（信噪比升级 · 2026-10-16 线上 161 条驱动）──
//
// 背景：线上实测情报库 161 条里 118 条是页面 URL，且**全部产自同一次基线扫描**
// ⇒ 「新 URL 即情报」把站点地图当成了情报，无限产噪音。判据据此升级为三层。

test('★ isStructuralPage：真实线上样本——栏目页/根路径是容器，文章页是内容', () => {
  // 样本直接取自 2026-10-16 线上情报库（sues.edu.cn 实爬结果，非构造样本）
  const structural = [
    'https://www.sues.edu.cn/',
    'https://www.sues.edu.cn/zhxw/list.htm',
    'https://www.sues.edu.cn/17465/list.htm',
    'https://www.sues.edu.cn/213/list.htm',
    'https://www.sues.edu.cn/news/',
  ]
  const content = [
    'https://www.sues.edu.cn/5d/6d/c26758a286061/page.htm',
    'https://www.sues.edu.cn/13/64/c278a267108/page.htm',
    'https://www.sues.edu.cn/95/a7/c26791a300455/page.htm',
  ]
  for (const u of structural) assert.equal(isStructuralPage(u), true, `结构页漏判：${u}`)
  for (const u of content) assert.equal(isStructuralPage(u), false, `内容页误判：${u}`)
})

test('isStructuralPage：非法输入原样放行（不抛，交给上层判据）', () => {
  assert.equal(isStructuralPage('not a url'), false)
})

test('★ 尸体样本：list.htm 必须被拦——判据若恒 false 这条就挂', () => {
  // 「恒为空的输出不是证据」：这条断言的就是「判据真的会拦」，而不是「它没拦错人」
  assert.equal(isIntelWorthy('https://www.sues.edu.cn/17465/list.htm', { isBaseline: true }), false)
  assert.equal(
    isIntelWorthy('https://www.sues.edu.cn/17465/list.htm', { isBaseline: false }),
    false,
    '结构页与是否基线无关——容器永远不是情报',
  )
})

test('★ isIntelWorthy：基线只收高价值类（附件/论文），后续扫描才收页面', () => {
  const page = 'https://www.sues.edu.cn/5d/6d/c26758a286061/page.htm'
  const att = 'https://www.sues.edu.cn/_upload/article/files/x/gonggao.pdf'
  assert.equal(isIntelWorthy(page, { isBaseline: true }), false, '基线期「站点本来就有这页」不是新闻')
  assert.equal(isIntelWorthy(page, { isBaseline: false }), true, '后续扫描新出现的页面可能是新闻')
  assert.equal(isIntelWorthy(att, { isBaseline: true }), true, '附件首次发现即有价值（它本身就是信息载体）')
  assert.equal(isIntelWorthy(att, { isBaseline: false }), true)
})

test('isIntelWorthy：不传 opts 时按「非基线」处理（向后兼容旧调用点）', () => {
  assert.equal(isIntelWorthy('https://a.b/article/123.htm'), true)
})

test('isIntelWorthy：协议文件与非 http 仍被拦（原有判据不退化）', () => {
  assert.equal(isIntelWorthy('https://a.b/robots.txt'), false)
  assert.equal(isIntelWorthy('not-a-url'), false)
})

// ── api 源（声明式 JSON 端点 · 2026-10-17）──────────────────────────────
//
// 存在理由：大量高价值源是 JSON API（实测币安公告端点公开可用），而网页形态是 SPA。
// 关键判据：api 条目是**声明式精选**（itemsPath 指向的就是「公告列表」这类目标集合），
// 不受基线判据限制——否则首次扫描的公告会被当页面全丢掉（判据比对象严）。

test('★ classifyItem：api 源判为 api；附件判据优先于 api（pdf 仍是附件）', () => {
  assert.equal(classifyItem('https://x/a/1', undefined, 'api'), 'api')
  assert.equal(classifyItem('https://x/a/1.pdf', undefined, 'api'), 'attachment', '附件是更强的信号（文件类型明确）')
  assert.equal(classifyItem('https://x/a/1', undefined, 'crawl'), 'page')
})

test('★ isHighValue：单一真源——三类高价值，page/unknown 不是', () => {
  assert.equal(isHighValue('attachment'), true)
  assert.equal(isHighValue('paper'), true)
  assert.equal(isHighValue('api'), true)
  assert.equal(isHighValue('page'), false)
  assert.equal(isHighValue('unknown'), false)
})

test('★★ 尸体样本：api 源首次扫描（基线）必须放行——漏了豁免这条就挂', () => {
  // 币安公告的真实形态：文章页 URL，非附件非结构页
  const announce = 'https://www.binance.com/en/support/announcement/e52ef13311eb4e1a96f07099152e61d5'
  assert.equal(
    isIntelWorthy(announce, { isBaseline: true, source: 'api' }),
    true,
    'api 条目是声明式精选，不是站点地图噪音——基线判据不适用',
  )
  // 对照组：同一 URL 来自 crawl 时，基线期必须被拦（证明豁免确实只对 api 生效）
  assert.equal(
    isIntelWorthy(announce, { isBaseline: true, source: 'crawl' }),
    false,
    '对照组：crawl 源的页面在基线期仍必须被拦——否则豁免写宽了',
  )
})

test('isIntelWorthy：结构页即使来自 api 源也被拦（豁免没有写宽）', () => {
  assert.equal(isIntelWorthy('https://x/list.htm', { isBaseline: true, source: 'api' }), false)
})

// ── kindTag（单一真源 · 2026-10-17 实测事故驱动）─────────────────────────
//
// 事故：新增 api kind 时我改了 digest 的渲染却漏了 intel_scan 的
// ⇒ 币安公告在扫描读数里显示成 [页面]，**读数失真而没有任何报错**。
// 处置不是「下次记得改两处」，而是抽成单一真源 + 加结构断言。

test('★ kindTag：四类标签 + 未知兜底（兜底不许是空串——空串会让读数缺一列）', () => {
  assert.equal(kindTag('attachment'), '[附件]')
  assert.equal(kindTag('paper'), '[论文]')
  assert.equal(kindTag('api'), '[公告]')
  assert.equal(kindTag('page'), '[页面]')
  assert.equal(kindTag('unknown'), '[页面]')
  assert.equal(kindTag('some-future-kind'), '[页面]', '未来新增 kind 时兜底仍要有值')
})

test('★★ 结构断言：index.ts 不得再有硬编码标签字面量（防枚举式漂移复发）', () => {
  // 「结构 > 纪律」：靠「记得改 N 处」必然复发；把判据变成可执行断言才拦得住
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const hits = [...src.matchAll(/'\[(附件|论文|公告|页面)\]'/g)].map((m) => m[0])
  assert.deepEqual(hits, [], `index.ts 仍硬编码标签：${hits.join(', ')}——必须走 kindTag()`)
})
