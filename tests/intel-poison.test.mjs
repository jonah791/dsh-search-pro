/**
 * 批量同模板检测测试（纯函数，零 IO、零网络）。
 *
 * 本文件锁的是**关系型判据**（2026-11-08）：同仓库名 24h 内跨 ≥5 个不同 owner。
 * 为什么不是单条目阈值——实测两轮被反向适配（第一批 fork 46-51 过 `stars:>50`，
 * 加 `forks:<40` 后第二批把 fork 刷到 1-10 照样过）。详见 `src/intel-poison.ts` 头注。
 *
 * 每条判据都配一条**尸体**（该判不中的样本）：只有正向样本的测试，
 * 在判据恒真（什么都拦）时也会全绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findTemplateBatches, suppressIds } from '../lib/intel-poison.js'

const HOUR = 3_600_000
const BASE = Date.parse('2026-11-06T18:16:00.000Z')

/** 造一条情报条目 */
function item({ owner, repo, hoursAfter = 0, status = 'new', targetId = 'api-github-new-repos' }) {
  const t = new Date(BASE + hoursAfter * HOUR).toISOString()
  return {
    id: `https://github.com/${owner}/${repo}`,
    targetId,
    url: `https://github.com/${owner}/${repo}`,
    kind: 'api',
    title: `${owner}/${repo}`,
    foundAt: t,
    publishedAt: t,
    status,
  }
}

/** 造一批同模板仓（n 个不同 owner） */
function batch(n, { repo = 'ai-manus', spreadHours = 0, status = 'new' } = {}) {
  return Array.from({ length: n }, (_, i) =>
    item({ owner: `owner${i}`, repo, hoursAfter: (spreadHours / Math.max(n - 1, 1)) * i, status }),
  )
}

test('命中：5 个不同 owner 同名、24h 内 ⇒ 返回一批', () => {
  const out = findTemplateBatches(batch(5))
  assert.equal(out.length, 1)
  assert.equal(out[0].repo, 'ai-manus')
  assert.equal(out[0].owners.length, 5)
  assert.equal(out[0].ids.length, 5)
})

test('尸体：4 个 owner（低于阈值 5）⇒ 不命中', () => {
  assert.deepEqual(findTemplateBatches(batch(4)), [])
})

test('尸体：5 个 owner 但跨度 30h（> 24h 窗）⇒ 不命中', () => {
  assert.deepEqual(findTemplateBatches(batch(5, { spreadHours: 30 })), [])
})

test('边界：跨度恰好 24h 内（23.9h）⇒ 命中', () => {
  const out = findTemplateBatches(batch(5, { spreadHours: 23.9 }))
  assert.equal(out.length, 1)
})

test('仓库名归一：ai--manus / ai_manus / AI-Manus 视为同一个', () => {
  const items = [
    item({ owner: 'a', repo: 'ai--manus' }),
    item({ owner: 'b', repo: 'ai_manus', hoursAfter: 1 }),
    item({ owner: 'c', repo: 'AI-Manus', hoursAfter: 2 }),
    item({ owner: 'd', repo: 'ai---manus', hoursAfter: 3 }),
    item({ owner: 'e', repo: 'ai__manus', hoursAfter: 4 }),
  ]
  const out = findTemplateBatches(items)
  assert.equal(out.length, 1, '五种写法必须归一到同一组')
  assert.equal(out[0].owners.length, 5)
})

test('尸体：同 owner 开 5 个同名仓 ⇒ 不算（distinct owner 才是判据）', () => {
  const items = Array.from({ length: 5 }, (_, i) =>
    item({ owner: 'sameguy', repo: `ai-manus`, hoursAfter: i }),
  )
  assert.deepEqual(findTemplateBatches(items), [])
})

test('尸体：已处置（status=seen/starred/dropped）不参与判据', () => {
  assert.deepEqual(findTemplateBatches(batch(5, { status: 'seen' })), [])
  assert.deepEqual(findTemplateBatches(batch(5, { status: 'dropped' })), [])
})

test('尸体：缺时间 ⇒ 不判（读不到 ≠ 时间集中）', () => {
  const items = Array.from({ length: 5 }, (_, i) => {
    const it = item({ owner: `o${i}`, repo: 'ai-manus' })
    delete it.foundAt
    delete it.publishedAt
    return it
  })
  assert.deepEqual(findTemplateBatches(items), [])
})

test('尸体：不同 target 的同名仓不合并（跨源要分开算）', () => {
  const a = batch(3).map((x) => ({ ...x, targetId: 'src-a', id: `a-${x.id}` }))
  const b = batch(3).map((x) => ({ ...x, targetId: 'src-b', id: `b-${x.id}` }))
  assert.deepEqual(findTemplateBatches([...a, ...b]), [], '每组只有 3 个 owner，不该合并成 6')
})

test('suppressIds 只压本批新增，不碰历史条目', () => {
  const all = batch(5)
  const batches = findTemplateBatches(all)
  const newOnes = all.slice(0, 2) // 本轮只新增 2 条
  const suppressed = suppressIds(batches, newOnes)
  assert.equal(suppressed.size, 2)
  assert.ok([...suppressed].every((id) => newOnes.some((n) => n.id === id)))
})

test('真项目不被误杀：单件高星仓（1 owner）不命中', () => {
  const items = [
    item({ owner: 'TIGER-AI-Lab', repo: 'WebsiteBench' }),
    item({ owner: 'bytedance', repo: 'axion1_0', hoursAfter: 1 }),
    item({ owner: 'Sandflow-ai', repo: 'sand3d', hoursAfter: 2 }),
  ]
  assert.deepEqual(findTemplateBatches(items), [])
})

// ── 2026-11-09 首次真实运行驱动的回归 ──────────────────────────────────────
// 当天漏网 2 条：thecoderrrer/manus-ai 与 abhinay-h/manus-ai（词序反转），
// 各自成组、组内 2 个 owner < 阈值 ⇒ 没命中。修法是把仓库名归一改成词序无关。

test('词序反转必须同组：ai-manus 与 manus-ai 混在一起仍命中（真实漏网样本）', () => {
  const items = [
    item({ owner: 'a', repo: 'ai-manus' }),
    item({ owner: 'b', repo: 'ai--manus', hoursAfter: 1 }),
    item({ owner: 'c', repo: 'manus-ai', hoursAfter: 2 }),
    item({ owner: 'd', repo: 'ai_manus', hoursAfter: 3 }),
    item({ owner: 'e', repo: 'Manus-AI', hoursAfter: 4 }),
  ]
  const out = findTemplateBatches(items)
  assert.equal(out.length, 1, '五种写法（含词序反转）必须归一到同一组')
  assert.equal(out[0].owners.length, 5)
})

test('尸体：词集合不同的两组不合并（防止归一过头）', () => {
  // ⚠ owner 必须两组不同，否则 distinct owner 凑不够阈值，测的就不是「分组」而是「阈值」
  const c = batch(3).map((x, i) => ({ ...x, id: `c-${x.id}`, title: `co${i}/sand3d` }))
  const d = batch(3).map((x, i) => ({ ...x, id: `d-${x.id}`, title: `do${i}/websitebench` }))
  assert.deepEqual(findTemplateBatches([...c, ...d]), [], '不同词集合各 3 个 owner，不该凑成 6')

  // 词序重排确实会被归一——这是已知且接受的代价，此处固定其行为，防止将来误当 bug 修
  const a = batch(3).map((x, i) => ({ ...x, id: `a-${x.id}`, title: `ao${i}/agent-memory` }))
  const b = batch(3).map((x, i) => ({ ...x, id: `b-${x.id}`, title: `bo${i}/memory-agent` }))
  assert.equal(findTemplateBatches([...a, ...b]).length, 1, '词序重排会被归一（已知代价，非 bug）')
})
