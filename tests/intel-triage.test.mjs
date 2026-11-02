/**
 * 情报状态模型三条判据（2026-11-03 · lh-00b2d093 / lh-4f279298 / lh-8b55b478）。
 *
 * 锁的都是**读数口径**——这类改动没有编译错误、不会崩、只会静默给错数字，
 * 所以必须由测试锁住，不能靠「重启后肉眼看一眼」。每个口径都配了一条
 * **防回退探针**（断言旧行为必须已消失），因为「改对了」与「改回去了」
 * 在肉眼读数上往往长得一样。
 *
 * 夹具纪律：`mkdtempSync` 隔离目录，绝不触碰生产 `<DSH_HOME>/intel/`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IntelStore } from '../lib/intel-store.js'
import { intelStats, intelUnreadBreakdown, renderIntelUnreadLine } from '../lib/intel.js'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'intel-triage-test-'))
  return { store: new IntelStore(dir), dir }
}

const NOW = new Date().toISOString()
function item(id, extra = {}) {
  return { id, targetId: 't', url: `https://x.example/${id}`, kind: 'paper', foundAt: NOW, status: 'new', ...extra }
}

// ── lh-00b2d093：分诊 ≠ 读过，也不是「没价值」 ──────────────────────────────

test('★ 分诊后条目移出「未读」视野，而 status 仍是 new（不必撒谎）', () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([item('a'), item('b')])
    assert.equal(store.listItems({ status: 'new' }).items.length, 2)

    assert.equal(store.patchItem('b', { triaged: true }), true)
    assert.deepEqual(
      store.listItems({ status: 'new' }).items.map((i) => i.id),
      ['a'],
      '分诊过的条目应移出「未读」视野',
    )

    // ⚠ 关键：它**不是**靠改成 seen/dropped 做到的
    const raw = store.listItems({ status: 'new', includeTriaged: true }).items.find((i) => i.id === 'b')
    assert.equal(raw.status, 'new', 'status 必须原样不动——分诊与裁决正交')
    assert.equal(raw.triaged, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('反向对照：includeTriaged=true 仍能看见已分诊条目（防「关掉与修好长得一样」）', () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([item('a'), item('b', { triaged: true })])
    assert.equal(store.listItems({ status: 'new' }).items.length, 1, '缺省排除')
    assert.equal(store.listItems({ status: 'new', includeTriaged: true }).items.length, 2, '显式要求时可见')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('存量兼容：没有 triaged 字段的条目行为完全不变（生产 864 条都无此字段）', () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([item('a'), item('b')])
    assert.equal(store.listItems({ status: 'new' }).items.length, 2, '无 triaged 字段 ⇒ 未被误排除')
    assert.equal(store.listItems({ status: 'seen' }).items.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('分诊不影响按其它状态查询：查 seen 时不因 triaged 被过滤', () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([item('a', { status: 'seen', triaged: true })])
    assert.equal(store.listItems({ status: 'seen' }).items.length, 1, '查 seen 时分诊与否无关紧要')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── lh-4f279298：「读过」不能只数 seen ──────────────────────────────────────

test('★ 读过 = seen + starred + dropped（旧口径只数 seen，starred 整个消失）', () => {
  const st = intelStats(
    [
      item('n', { status: 'new' }),
      item('s', { status: 'seen' }),
      item('st', { status: 'starred' }),
      item('d', { status: 'dropped' }),
    ],
    [],
  )
  assert.equal(st.read, 3, 'seen / starred / dropped 都是读过的形态')
  assert.equal(st.byStatus.seen, 1)
  assert.equal(st.byStatus.starred, 1)
  assert.equal(st.total, 4)
})

test('防回退探针：read 若被写回 byStatus.seen，这里必红', () => {
  const st = intelStats(
    [item('s', { status: 'seen' }), item('st', { status: 'starred' }), item('d', { status: 'dropped' })],
    [],
  )
  assert.notEqual(st.read, st.byStatus.seen ?? 0, '读过 ≠ 只数 seen')
})

test('分诊未读不算进「读过」（triaged 不是读过的证据）', () => {
  const st = intelStats([item('a', { triaged: true })], [])
  assert.equal(st.read, 0, '分诊过但没读 ⇒ 不算读过')
  assert.equal(st.triaged, 1)
})

// ── lh-8b55b478：未读按「正确动作」分段 ────────────────────────────────────

test('★ arxiv 与 api 必须分开计数（混成一个数会把「无需清空」读成「清不完」）', () => {
  const b = intelUnreadBreakdown([
    item('a1', { source: 'arxiv', kind: 'paper' }),
    item('a2', { source: 'arxiv', kind: 'paper' }),
    item('p1', { source: 'api', kind: 'api' }),
    item('c1', { source: 'crawl', kind: 'attachment' }),
    item('g1', { source: 'crawl', kind: 'page' }),
  ])
  assert.equal(b.arxiv, 2)
  assert.equal(b.api, 1)
  assert.equal(b.otherHigh, 1, 'crawl 的 attachment 是高价值')
  assert.equal(b.otherLow, 1, 'crawl 的 page 是噪音')
  assert.equal(b.total, 5)
})

test('注入文案：arxiv 段带「不是待读债」的动作指引，api 段带判据，旧文案必须消失', () => {
  const line = renderIntelUnreadLine({ arxiv: 837, api: 27, otherHigh: 0, otherLow: 0, total: 864 }, '01:03')
  assert.match(line, /定向 27 条待判/)
  assert.match(line, /arxiv 837 条待筛/)
  assert.match(line, /不是待读债/)
  // 防回退探针：不依赖具体数字，只盯旧文案的措辞
  assert.doesNotMatch(line, /条高价值未读/, '旧文案的措辞必须已消失，否则这次改动静默回退')
})

test('分段退化：只有 arxiv 时不出现空的 api 段', () => {
  const line = renderIntelUnreadLine({ arxiv: 5, api: 0, otherHigh: 0, otherLow: 0, total: 5 }, '01:03')
  assert.doesNotMatch(line, /定向/)
  assert.match(line, /arxiv 5 条待筛/)
})

test('★ 入口必须自带「它现在可见吗」——提示指向不可执行的动作正是本条要堵的 bug（t-bd952b09）', () => {
  const line = renderIntelUnreadLine({ arxiv: 1, api: 1, otherHigh: 0, otherLow: 0, total: 2 }, '01:03')
  assert.match(line, /evidence-retrieval/, '必须写明工具挂在哪个域')
  assert.match(line, /toolface/, '必须给开域入口——这行每轮注入，不写就是在推荐一个默认不可执行的动作')
  // 防回退探针：旧文案以「立刻扫）」收尾，说明它没有任何可见性提示
  assert.doesNotMatch(line, /立刻扫）$/, '旧文案的结尾形态必须已消失')
})
