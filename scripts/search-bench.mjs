/**
 * L4 · search-bench：搜索增强的回归基准（改前改后对账）
 *
 * 判据不是「有没有结果」，而是四件事：
 *   ① 命中率（几条查询有结果）② 唯一域名数（多样性）③ 引擎级可用性 ④ 深研的「每答调用数」
 * 用法：node scripts/search-bench.mjs [--json]
 * 只读：不写任何状态，不改插件配置。
 */
import { searchWeb, searchParallel, searchSearxng } from '../lib/engines.js'
import { deepResearch } from '../lib/research.js'

const QUERIES = [
  'how to enable json format in self-hosted searxng',
  'agent web search query fan-out best practices 2026',
  'tavily vs brave search api free tier limits',
  'deep research agent architecture retrieval loop',
  'MCP web search server open source',
  'startup credits list editorial page',
  'cloudflare worker x402 payment middleware',
  'react 19 server components streaming pitfalls',
  'readthedocs custom build commands prebuilt html',
  'github actions workflow dispatch permissions matrix',
  'fastapi background task vs celery comparison',
  'postgres 17 jsonb indexing performance](', // 故意留一个坏查询：bench 必须能把它判成「空手」而不是崩
]

/** 唯一域名数 */
function domains(list) {
  const s = new Set()
  for (const r of list) {
    try {
      s.add(new URL(r.url).hostname.replace(/^www\./, ''))
    } catch {
      /* skip */
    }
  }
  return s.size
}

async function timed(fn) {
  const t0 = Date.now()
  try {
    const v = await fn()
    return { ok: true, v, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, err: String(e?.message ?? e), ms: Date.now() - t0 }
  }
}

const out = { at: new Date().toISOString(), engines: {}, deep: null, queries: {} }

// ① 引擎级基线（每个引擎独立跑第 1 条查询，暴露「哪个引擎活着」）
for (const [name, fn] of [
  ['parallel', () => searchParallel(QUERIES[0], 10, { objective: QUERIES[0], sessionId: 'search-bench' })],
  ['searxng', () => searchSearxng(QUERIES[0])],
  ['duckduckgo', () => searchWeb({ query: QUERIES[0], engines: ['duckduckgo'] })],
  ['brave', () => searchWeb({ query: QUERIES[0], engines: ['brave'] })],
]) {
  const r = await timed(fn)
  out.engines[name] = {
    ok: r.ok && Array.isArray(r.v) && r.v.length > 0,
    count: r.ok && Array.isArray(r.v) ? r.v.length : 0,
    domains: r.ok && Array.isArray(r.v) ? domains(r.v) : 0,
    ms: r.ms,
    err: r.ok ? undefined : r.err,
  }
  console.log(`[engine] ${name.padEnd(11)} ok=${out.engines[name].ok} n=${out.engines[name].count} domains=${out.engines[name].domains} ${r.ms}ms ${r.ok ? '' : 'ERR ' + r.err}`)
}

// ② 聚合（默认引擎组）：命中率 + 多样性 + 每答调用数
let hit = 0
let totalDomains = 0
for (const q of QUERIES) {
  const r = await timed(() => searchWeb({ query: q, sessionId: 'search-bench' }))
  const n = r.ok && Array.isArray(r.v) ? r.v.length : 0
  const d = r.ok && Array.isArray(r.v) ? domains(r.v) : 0
  if (n > 0) hit++
  totalDomains += d
  out.queries[q] = { n, domains: d, ms: r.ms, ok: r.ok }
  console.log(`[web] n=${String(n).padStart(3)} domains=${String(d).padStart(3)} ${String(r.ms).padStart(5)}ms  ${q.slice(0, 58)}`)
}

// ③ 深研：一条真实问题，记「每答调用数」与抓取数
const dr = await timed(() => deepResearch({ query: 'how to improve agent web search quality query fan-out reranking', sessionId: 'search-bench', maxSources: 5 }))
if (dr.ok && dr.v) {
  out.deep = { ok: dr.v.ok, sources: dr.v.sources.length, quoted: dr.v.sources.filter((s) => s.content).length, stats: dr.v.stats, ms: dr.ms }
  console.log(`[deep] sources=${dr.v.sources.length} fetched=${dr.v.stats.fetched} engineCalls=${dr.v.stats.engineCalls} ${dr.ms}ms`)
} else {
  out.deep = { ok: false, err: dr.err, ms: dr.ms }
  console.log('[deep] ERR ' + dr.err)
}

const summary = {
  engineHitRate: Object.values(out.engines).filter((e) => e.ok).length + '/' + Object.keys(out.engines).length,
  queryHitRate: hit + '/' + QUERIES.length,
  avgDomains: Number((totalDomains / QUERIES.length).toFixed(1)),
  deep: out.deep,
}
console.log('\n=== summary ===')
console.log(JSON.stringify(summary, null, 2))
if (process.argv.includes('--json')) console.log('\n' + JSON.stringify(out))
