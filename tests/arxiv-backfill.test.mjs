/**
 * arxiv **定向回填**测试（纯函数 + 桩 fetcher，零网络）。
 *
 * 存在理由（2026-10-17 线上实测抓出）：`pickBackfill` 的覆盖面 = **本轮重扫结果 ∩ 库里缺字段条目**。
 * 一旦查询变更（`arxiv-deepweb` 三次重建）或源侧排序漂移，这个交集会**归零** ——
 * 实测 23 条旧论文全缺 `publishedAt`，而同 query 未变的另一目标补上了 9 条。
 * ⇒ 回填不能指望「重扫恰好又返回它」，必须能按**条目标识**直接问源。
 *
 * 本文件锁四件事：
 * ① Atom 解析（搜索与回填**共用**同一份 ⇒ 锁住它 = 同时锁住两条路径）
 * ② **id 形态差异**：源返回 `http://arxiv.org/abs/...`，库里是 `https://...` ⇒ 归一后必须仍能匹配
 * ③ **幂等**：缺口为空时**零请求**（不是「请求了但没写」）
 * ④ 源没给时间 ⇒ **不写**（「源没给」与「写了个空值」是两件事）
 *
 * 夹具纪律：临时目录 `mkdtempSync` 隔离，**绝不触碰生产 `<DSH_HOME>/intel/`**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseArxivEntries, arxivIdFromUrl, academicArxiv } from '../lib/deep.js'
import { backfillArxivByIds } from '../lib/intel-scan.js'
import { IntelStore } from '../lib/intel-store.js'
import { publishedAtFromExtra } from '../lib/intel-api.js'

// ── 真实语料锚（2026-10-17 实抓 export.arxiv.org/api/query?id_list=...）──
// 源侧 `<id>` 是 **http**（不是 https），`<published>` 是带 Z 的完整 ISO。
const REAL_XML = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query: search_query=&amp;id_list=1612.05413v1,1902.04790v1</title>
  <entry>
    <id>http://arxiv.org/abs/1612.05413v1</id>
    <updated>2016-12-16T10:10:16Z</updated>
    <published>2016-12-16T10:10:16Z</published>
    <title>Analyzing Web Archives Through Topic and Event Focused Sub-collections</title>
    <summary>  We present a method ...  </summary>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1902.04790v1</id>
    <updated>2019-02-13T08:53:59Z</updated>
    <published>2019-02-13T08:53:59Z</published>
    <title>SaGe: Web Preemption for Public SPARQL Query Services</title>
    <summary>  Query preemption ...  </summary>
  </entry>
</feed>`

/** 生成一条 entry（可指定是否带 `<published>`） */
function entryXml(id, published) {
  const pub = published === undefined ? '' : `<published>${published}</published>`
  return `<entry><id>${id}</id><title>T ${id}</title>${pub}<summary>S</summary></entry>`
}
const feedOf = (...entries) => `<?xml version='1.0'?><feed>${entries.join('')}</feed>`

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'arxiv-backfill-test-'))
  return { store: new IntelStore(dir), dir }
}

function paperItem(id, targetId = 'arxiv-deepweb') {
  return {
    id,
    targetId,
    url: id,
    kind: 'paper',
    foundAt: '2026-10-17T01:00:00.000Z',
    status: 'new',
    source: 'arxiv',
  }
}

// ── ① Atom 解析（两条路径共用的那一份）────────────────────────────────

test('★ 真实语料：Atom 解析出 id/title/published（搜索与回填共用同一份）', async () => {
  const rs = parseArxivEntries(REAL_XML, 10)
  assert.equal(rs.length, 2)
  assert.equal(rs[0].url, 'http://arxiv.org/abs/1612.05413v1')
  assert.equal(rs[0].extra.published, '2016-12-16')
  assert.equal(rs[1].extra.published, '2019-02-13')
  // 区分力：`<feed>` 自己也带 `<title>` —— 若切分没丢掉 feed 头，
  // 第一条的标题会变成 "arXiv Query: ..."（那是 feed 标题，不是论文标题）
  assert.ok(rs[0].title.startsWith('Analyzing Web Archives'), `取到 feed 标题了：${rs[0].title}`)
})

test('★ 尸体样本：entry 缺 `<published>` ⇒ 空串（不猜），解析器不得编一个时间', async () => {
  const rs = parseArxivEntries(feedOf(entryXml('http://arxiv.org/abs/1111.11111v1')), 5)
  assert.equal(rs.length, 1)
  assert.equal(rs[0].extra.published, '')
  // 「源没给时间」必须在**下游**表现为 undefined（而不是 1970 或今天）
  assert.equal(publishedAtFromExtra(rs[0].extra), undefined)
})

test('parseArxivEntries 遵守 limit（截断发生在解析后，不是取数后）', async () => {
  const xml = feedOf(entryXml('http://arxiv.org/abs/1v1'), entryXml('http://arxiv.org/abs/2v1'))
  assert.equal(parseArxivEntries(xml, 1).length, 1)
})

// ── ② arxiv id 提取 ───────────────────────────────────────────────

test('★ arxivIdFromUrl：http/https 两种形态都取到（源与库的形态不同）', async () => {
  assert.equal(arxivIdFromUrl('https://arxiv.org/abs/1612.05413v1'), '1612.05413v1')
  assert.equal(arxivIdFromUrl('http://arxiv.org/abs/1902.04790v1'), '1902.04790v1')
})

test('★ 尸体样本：非 `/abs/` 形态 ⇒ null（不猜 —— 猜出来的 id 会让源静默返回 0 条）', async () => {
  assert.equal(arxivIdFromUrl('https://arxiv.org/list/cs.AI/recent'), null)
  assert.equal(arxivIdFromUrl('https://arxiv.org/abs/1612.05413v1?context=cs'), null)
  assert.equal(arxivIdFromUrl('https://example.com/abs/1612.05413v1'), null)
})

// ── ③ 定向回填本体 ────────────────────────────────────────────────

test('★★ 核心：源返回 http 形态 id、库里是 https ⇒ 归一后仍须匹配并补写', async () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([paperItem('https://arxiv.org/abs/1612.05413v1')])
    let calls = 0
    const n = await (async () => {
      const r = await backfillArxivByIds(store, 'arxiv-deepweb', async (url) => {
        calls += 1
        assert.ok(url.includes('id_list=1612.05413v1'), `请求里没带对 id：${url}`)
        return feedOf(entryXml('http://arxiv.org/abs/1612.05413v1', '2016-12-16T10:10:16Z'))
      })
      return r
    })()
    assert.equal(calls, 1)
    assert.equal(n, 1)
    // 落盘核实：不是「函数返回 1」就算数
    const it = store.listItems({ targetId: 'arxiv-deepweb', limit: 0 }).items[0]
    assert.equal(it.publishedAt, '2016-12-16T00:00:00.000Z')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 幂等：缺口为空 ⇒ **零请求**（补完就不再打源）', async () => {
  const { store, dir } = tempStore()
  try {
    const it = paperItem('https://arxiv.org/abs/1612.05413v1')
    store.appendItems([{ ...it, publishedAt: '2016-12-16T00:00:00.000Z' }])
    let calls = 0
    const n = await backfillArxivByIds(store, 'arxiv-deepweb', async () => {
      calls += 1
      return feedOf()
    })
    assert.equal(n, 0)
    // 区分力：若实现改成「先请求再判断要不要写」，calls 会是 1 ⇒ 这条挂。
    // 幂等的判据是**不打源**，不是「打了但没写」。
    assert.equal(calls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 有界：缺口多于 maxIds ⇒ 只请求 maxIds 个 id', async () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([
      paperItem('https://arxiv.org/abs/1v1'),
      paperItem('https://arxiv.org/abs/2v1'),
      paperItem('https://arxiv.org/abs/3v1'),
    ])
    let seen = null
    const n = await backfillArxivByIds(
      store,
      'arxiv-deepweb',
      async (url) => {
        seen = url.match(/id_list=([^&]*)/)[1].split(',')
        return feedOf()
      },
      2,
    )
    assert.equal(seen.length, 2)
    assert.equal(n, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 尸体样本：源没给时间 ⇒ 不写（「源没给」与「写了个空值」是两件事）', async () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([paperItem('https://arxiv.org/abs/1612.05413v1')])
    const n = await backfillArxivByIds(store, 'arxiv-deepweb', async () =>
      feedOf(entryXml('http://arxiv.org/abs/1612.05413v1')), // 无 <published>
    )
    assert.equal(n, 0)
    const it = store.listItems({ targetId: 'arxiv-deepweb', limit: 0 }).items[0]
    assert.equal(it.publishedAt, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只补本目标的条目（跨目标不得互相污染）', async () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([
      paperItem('https://arxiv.org/abs/1612.05413v1', 'arxiv-deepweb'),
      paperItem('https://arxiv.org/abs/1902.04790v1', 'arxiv-self-improving-agent'),
    ])
    const n = await backfillArxivByIds(store, 'arxiv-deepweb', async () =>
      feedOf(entryXml('http://arxiv.org/abs/1612.05413v1', '2016-12-16T10:10:16Z')),
    )
    assert.equal(n, 1)
    const other = store.listItems({ targetId: 'arxiv-self-improving-agent', limit: 0 }).items[0]
    assert.equal(other.publishedAt, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 已知语义：条目 id = URL 指纹 ⇒ 同资源被两个目标扫到 = 同一条（后写胜）', async () => {
  // 这不是缺陷，是**设计特性**（normalizeItem 注释：「指纹即 id，天然幂等」）——
  // 但它有可观测后果，必须显式锁住：若哪天有人把 id 改成「URL+targetId」，
  // 同一篇论文就会在两个目标下各存一份，跨目标去重失效（而症状只是「条目变多了」）。
  const { store, dir } = tempStore()
  try {
    store.appendItems([
      paperItem('https://arxiv.org/abs/1612.05413v1', 'arxiv-deepweb'),
      paperItem('https://arxiv.org/abs/1612.05413v1', 'arxiv-self-improving-agent'),
    ])
    assert.equal(store.listItems({ targetId: 'arxiv-deepweb', limit: 0 }).items.length, 0)
    assert.equal(store.listItems({ targetId: 'arxiv-self-improving-agent', limit: 0 }).items.length, 1)
    assert.equal(store.listItems({ limit: 0 }).items.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ sortByDate ⇒ URL 带 sortBy=submittedDate&sortOrder=descending（U20 实测修复）', async () => {
  let seen = ''
  await academicArxiv('deep web crawling', 5, {
    sortByDate: true,
    fetcher: async (url) => {
      seen = url
      return feedOf()
    },
  })
  assert.ok(seen.includes('sortBy=submittedDate'), `URL 里没带排序参数：${seen}`)
  assert.ok(seen.includes('sortOrder=descending'), `URL 里没带排序方向：${seen}`)
  // 区分力：监控源若退回相关性排序，返回的就是 2012/2016 年的老论文
  // （实测 A/B：默认 2019/2012/2016/2021/2026 混杂；降序 2026/2025/2025/2024/2024）。
})

test('★ 尸体样本：不给 sortByDate ⇒ URL **不得**带排序参数（既有调用方行为不变）', async () => {
  let seen = ''
  await academicArxiv('deep web crawling', 5, {
    fetcher: async (url) => {
      seen = url
      return feedOf()
    },
  })
  assert.ok(!seen.includes('sortBy'), `默认不该带排序参数：${seen}`)
})

test('非 arxiv 形态的条目被跳过（不发无谓请求）', async () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([{ ...paperItem('https://www.sues.edu.cn/list.htm'), kind: 'page' }])
    let calls = 0
    const n = await backfillArxivByIds(store, 'arxiv-deepweb', async () => {
      calls += 1
      return feedOf()
    })
    assert.equal(n, 0)
    assert.equal(calls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
