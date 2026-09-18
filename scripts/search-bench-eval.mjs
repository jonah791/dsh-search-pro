/**
 * L4+ · 带标注的搜索评测（loop-2 产出）：把「有没有结果」升级为 **hit@k / MRR / 引擎覆盖**
 *
 * 为什么加它：第一版 bench 只数条数与域名数（2026-09-18 调研结论 [3] 指出真正可辩护的检索
 * 评测要量 precision/recall/MRR）。这里用**期望域名**做弱标注（label 是我自己的先验，不是金标准，
 * 但足以分辨「改动前/改动后」与「哪个引擎在真正贡献」）。
 *
 * 用法：node scripts/search-bench-eval.mjs
 * 只读：不写状态、不改配置。
 */
import { searchWeb } from '../lib/engines.js'

/** q=查询，expect=期望命中的域名（弱标注），why=为什么这么标 */
const CASES = [
  { q: 'searxng enable json api search', expect: 'docs.searxng.org', why: '官方文档站' },
  { q: 'parallel search api free tier for agents', expect: 'parallel.ai', why: '供应商官网' },
  { q: 'cloudflare workers x402 payment middleware', expect: 'cloudflare.com', why: '平台官方文档' },
  { q: 'readthedocs custom build commands prebuilt html output', expect: 'docs.readthedocs.io', why: '官方文档' },
  { q: 'github actions workflow dispatch permissions matrix', expect: 'docs.github.com', why: '官方文档' },
  { q: 'postgres jsonb gin index performance', expect: 'postgresql.org', why: '官方文档' },
  { q: 'react server components suspense streaming', expect: 'react.dev', why: '官方文档' },
  { q: 'tavily search api pricing free tier limits', expect: 'tavily.com', why: '供应商官网' },
]

const dom = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
const match = (r, expect) => dom(r.url).endsWith(expect) || dom(r.url).includes(expect)

async function main() {
  let hits3 = 0
  let hits5 = 0
  let mrrSum = 0
  const perEngine = new Map()
  const t0 = Date.now()
  const rows = []

  for (const c of CASES) {
    const s0 = Date.now()
    let list = []
    try {
      list = await searchWeb({ query: c.q, sessionId: 'bench-eval' })
    } catch {
      list = []
    }
    const ms = Date.now() - s0
    const idx = list.findIndex((r) => match(r, c.expect))
    const rank = idx >= 0 ? idx + 1 : 0
    if (rank > 0 && rank <= 3) hits3++
    if (rank > 0 && rank <= 5) hits5++
    mrrSum += rank > 0 ? 1 / rank : 0
    for (const r of list) {
      const k = r.source.split(':')[0]
      const e = perEngine.get(k) ?? { n: 0, hit: 0 }
      e.n++
      if (match(r, c.expect)) e.hit++
      perEngine.set(k, e)
    }
    rows.push({ q: c.q, expect: c.expect, rank, n: list.length, ms })
    console.log(`${rank > 0 ? 'HIT ' : 'MISS'} rank=${rank || '-'} n=${String(list.length).padStart(3)} ${String(ms).padStart(5)}ms  ${c.expect.padEnd(22)} ${c.q.slice(0, 46)}`)
  }

  const n = CASES.length
  console.log('\n=== 评测结果（弱标注）===')
  console.log(JSON.stringify({
    cases: n,
    hit3: `${hits3}/${n}`,
    hit5: `${hits5}/${n}`,
    mrr: Number((mrrSum / n).toFixed(3)),
    totalMs: Date.now() - t0,
    engineCoverage: Object.fromEntries([...perEngine.entries()].map(([k, v]) => [k, `${v.hit}/${v.n}`])),
  }, null, 2))
  console.log('\n（engineCoverage = 该引擎贡献的结果里，命中期望域的条数/该引擎贡献总条数）')
  console.log(JSON.stringify(rows))
}

main()
