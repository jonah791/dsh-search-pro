/** L3 · 深研循环（deep research）：一次调用完成
 *  扇出（query fan-out）→ 多引擎并行 → 去重 + 域多样 → 抓正文 → **带引用的报告**
 *
 *  设计依据（2026-09-18 调研）：2026 年搜索增强的共识是「一次问对、一次答完」——
 *  ① 多查询扇出比链式重搜便宜；② 密集摘录能省掉逐页抓取；③ 判据是**每答调用数**而不是每请求成本；
 *  ④ 复杂问题才烧深研循环（简单查询走 search_web 快路径）。
 */

import { buildQueries } from './buildQuery.js'
import { searchWeb, searchParallel, searchSearxng, type SearchResult } from './engines.js'
import { fetchPage } from './fetch.js'
import { normalizeUrl } from './util.js'

export interface DeepArgs {
  query: string
  objective?: string
  sessionId?: string
  engines?: string[]
  /** 扇出查询条数（默认 4，含主查询） */
  variants?: number
  /** 抓正文的来源数（默认 5） */
  maxSources?: number
  fetch?: boolean
  /** 每个域名最多几条（默认 2）——避免单一站点刷屏 */
  perDomain?: number
  searxngBase?: string
  tavilyKey?: string
  serperKey?: string
  jinaKey?: string
}

export interface DeepSource {
  n: number
  title: string
  url: string
  domain: string
  engines: string[]
  excerpt: string
  content: string
}

export interface DeepResult {
  ok: boolean
  query: string
  queries: string[]
  report: string
  sources: DeepSource[]
  stats: { engineCalls: number; queries: number; sources: number; fetched: number; callsPerAnswer: number; rounds: number; gapFilled: number }
  error?: string
}

function domainOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** 扇出：主查询 + **意图形状的变体**（去引号、去年号、加指令式/落地式角度）
 *  实测（2026-09-18）：直接拿 buildQueries 的产物喂英文研究型问题，会得到
 *  `"整句带引号"` 与 `什么是 …` 这类**无效变体**（浪费槽位）⇒ 按语种分流，自己造角度。 */
export function fanOutQueries(query: string, max = 4): string[] {
  const q = query.trim()
  const out: string[] = q ? [q] : []
  const push = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  const isLatin = /^[\x20-\x7E\s]*$/.test(q)
  if (isLatin && q) {
    const stripped = q.replace(/[?!."'`]/g, '').replace(/\s+/g, ' ').trim()
    const core = stripped
      .split(' ')
      .filter((w) => w.length > 3)
      .slice(0, 6)
      .join(' ')
    push(core)
    push(`${core} best practices 2026`)
    push(`how to ${core}`)
    push(`${core} implementation techniques`)
  } else if (q) {
    push(`${q} 教程 指南`)
    push(`${q} 最佳实践`)
  }
  return out.slice(0, Math.max(1, max))
}

/** 打分排序：命中的引擎数越多越靠前；有密集摘录者优先 */
function scoreOf(r: SearchResult & { engines: string[] }): number {
  return r.engines.length * 10 + Math.min(3, Math.floor((r.snippet ?? '').length / 200))
}

export async function deepResearch(a: DeepArgs): Promise<DeepResult> {
  const primary = a.query.trim()
  const engines = a.engines?.length ? a.engines : ['parallel', 'searxng', 'duckduckgo']
  const queries = fanOutQueries(primary, Math.max(1, Math.min(6, a.variants ?? 4)))
  const maxSources = Math.max(1, Math.min(10, a.maxSources ?? 5))
  const perDomain = Math.max(1, a.perDomain ?? 2)
  const stats = { engineCalls: 0, queries: queries.length, sources: 0, fetched: 0, callsPerAnswer: 0, rounds: 1, gapFilled: 0 }

  const jobs: Promise<SearchResult[]>[] = []
  // ① Parallel：一次调用吃下整组扇出（它的形状天生支持多查询）——最省调用
  if (engines.includes('parallel')) {
    stats.engineCalls++
    jobs.push(
      searchParallel(primary, 12, {
        objective: a.objective ?? primary,
        sessionId: a.sessionId,
        extraQueries: queries.slice(1),
      }).catch(() => []),
    )
  }
  // ② 自托管 SearXNG：对主查询 + 前两条变体各查一次（本机、零成本）
  if (engines.includes('searxng')) {
    for (const q of queries.slice(0, 3)) {
      stats.engineCalls++
      jobs.push(searchSearxng(q, a.searxngBase, 10).catch(() => []))
    }
  }
  // ③ 其余免费引擎：只查主查询（保底，不放大调用数）
  const others = engines.filter((e) => e !== 'parallel' && e !== 'searxng')
  if (others.length) {
    stats.engineCalls++
    jobs.push(
      searchWeb({
        query: primary,
        engines: others,
        tavilyKey: a.tavilyKey,
        serperKey: a.serperKey,
        searxngBase: a.searxngBase,
      }).catch(() => []),
    )
  }

  const settled = await Promise.all(jobs)
  const byUrl = new Map<string, SearchResult & { engines: string[] }>()
  const mergeInto = (list: SearchResult[]) => {
    for (const r of list) {
      const key = normalizeUrl(r.url)
      if (!key) continue
      const prev = byUrl.get(key)
      if (prev) {
        if (!prev.engines.includes(r.source)) prev.engines.push(r.source)
        if ((r.snippet ?? '').length > (prev.snippet ?? '').length) prev.snippet = r.snippet
      } else {
        byUrl.set(key, { ...r, url: key, engines: [r.source] })
      }
    }
  }
  for (const list of settled) mergeInto(list)

  // 相关性 rerank（2026 调研结论之一）：引擎票数之外，再看查询词是否真落在标题/摘录里
  const terms = primary
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((w) => w.length >= 3)
  const relevance = (r: SearchResult): number => {
    const hay = `${r.title ?? ''} ${r.snippet ?? ''}`.toLowerCase()
    let hits = 0
    for (const t of terms) if (hay.includes(t)) hits++
    return hits
  }

  const pick = (want: number) => {
    const ranked = [...byUrl.values()].sort(
      (x, y) => scoreOf(y) + relevance(y) * 3 - (scoreOf(x) + relevance(x) * 3),
    )
    const out: (SearchResult & { engines: string[] })[] = []
    const per = new Map<string, number>()
    for (const r of ranked) {
      const d = domainOf(r.url)
      const c = per.get(d) ?? 0
      if (c >= perDomain) continue
      per.set(d, c + 1)
      out.push(r)
      if (out.length >= want) break
    }
    return out
  }

  let picked = pick(maxSources)

  // 缺口补查（gap fill · 深研循环的本质）：首选不足 ⇒ 用顶部结果的显著词再扇出一轮
  if (picked.length < maxSources) {
    const gapQueries = picked
      .slice(0, 2)
      .map((r) => (r.title ?? '').split(/\s+/).slice(0, 6).join(' ').trim())
      .filter((q) => q.length > 3)
    if (gapQueries.length) {
      stats.rounds = 2
      const more: SearchResult[][] = []
      if (engines.includes('parallel')) {
        stats.engineCalls++
        more.push(
          await searchParallel(primary, 12, {
            objective: a.objective ?? primary,
            sessionId: a.sessionId,
            extraQueries: gapQueries,
          }).catch(() => []),
        )
      }
      if (engines.includes('searxng')) {
        for (const q of gapQueries.slice(0, 2)) {
          stats.engineCalls++
          more.push(await searchSearxng(q, a.searxngBase, 10).catch(() => []))
        }
      }
      for (const list of more) mergeInto(list)
      const before = picked.length
      picked = pick(maxSources)
      stats.gapFilled = picked.length - before
    }
  }

  // ④ 抓正文（并行，失败即降级为「仅摘录」）
  const contents: string[] = await Promise.all(
    picked.map(async (r) => {
      if (a.fetch === false) return ''
      try {
        const f = await fetchPage(r.url, 'reader', a.jinaKey)
        stats.fetched++
        return (f.content ?? '').replace(/\s+/g, ' ').slice(0, 1500)
      } catch {
        return ''
      }
    }),
  )

  const sources: DeepSource[] = picked.map((r, i) => ({
    n: i + 1,
    title: r.title || r.url,
    url: r.url,
    domain: domainOf(r.url),
    engines: r.engines,
    excerpt: (r.snippet ?? '').replace(/\s+/g, ' ').slice(0, 400),
    content: contents[i] ?? '',
  }))
  stats.sources = sources.length
  stats.callsPerAnswer = sources.length ? Number((stats.engineCalls / 1).toFixed(2)) : 0

  const lines: string[] = []
  lines.push(`## 深研：${primary}`)
  lines.push(`扇出查询（${queries.length}）：${queries.map((q) => '`' + q + '`').join(' · ')}`)
  lines.push(`引擎调用 ${stats.engineCalls} 次 → 唯一来源 ${sources.length} 条（抓正文 ${stats.fetched} 条）`)
  lines.push('')
  if (!sources.length) {
    lines.push('_无结果：所有引擎都空手而归。先查引擎是否可用（search_quota / searxng 实例），再判定「真的没有」。_')
  }
  for (const s of sources) {
    lines.push(`**[${s.n}] ${s.title}**`)
    lines.push(`- ${s.url}`)
    lines.push(`- 命中引擎：${s.engines.join(', ')}`)
    if (s.excerpt) lines.push(`- 摘录：${s.excerpt}`)
    if (s.content) lines.push(`- 正文片段：${s.content.slice(0, 600)}${s.content.length > 600 ? '…' : ''}`)
    lines.push('')
  }
  lines.push('> 引用纪律：以上每条都带可复核 URL；报告里的每个断言都应指向某个 [n]。抓不到正文的条目只作线索，不作结论。')

  return { ok: true, query: primary, queries, report: lines.join('\n'), sources, stats }
}
