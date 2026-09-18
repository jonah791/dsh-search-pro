/** L3 · 深研循环（deep research）：一次调用完成
 *  扇出（query fan-out）→ 多引擎并行 → 去重 + 域多样 → 抓正文 → **带引用的报告**
 *
 *  设计依据（2026-09-18 调研）：2026 年搜索增强的共识是「一次问对、一次答完」——
 *  ① 多查询扇出比链式重搜便宜；② 密集摘录能省掉逐页抓取；③ 判据是**每答调用数**而不是每请求成本；
 *  ④ 复杂问题才烧深研循环（简单查询走 search_web 快路径）。
 */

import { buildQueries } from './buildQuery.js'
import { searchWeb, searchParallel, searchSearxng, type ChannelStat, type SearchResult } from './engines.js'
import { searchAcademic, searchGithub } from './deep.js'
import { fetchPage } from './fetch.js'
import { normalizeUrl, sleep } from './util.js'

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
  /** 是否过 SearXNG 就绪门（默认 true）。 */
  searxngGate?: boolean
  searxngReadyTimeoutMs?: number
  searxngKeepAliveMinutes?: number
  tavilyKey?: string
  serperKey?: string
  jinaKey?: string
  githubToken?: string
  /** 领域路由（默认 auto）：按意图自动追加 GitHub / 学术通道。 */
  routing?: 'auto' | 'off'
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
  stats: { engineCalls: number; queries: number; sources: number; fetched: number; callsPerAnswer: number; rounds: number; gapFilled: number; crossChecked: number }
  /** 逐通道读数（Q3/Q4 per-channel）——工具结果与 trace 共用。 */
  channels: ChannelStat[]
  /** 领域路由结论（2026-09-18 第二轮）。 */
  routing: { kind: RoutingKind; added: string[]; note: string }
  error?: string
}

/** 意图路由的领域分类。 */
export type RoutingKind = 'code' | 'academic' | 'general'

/** 领域路由判据（**纯函数**，可单测）：
 *  - `code`：GitHub/仓库/npm/SDK/API/源码/插件 这些词出现在问题里
 *  - `academic`：论文/文献/综述/study/survey/arxiv 这类研究词
 *  命中即**追加对应专用通道**（GitHub repo 搜索 / Semantic Scholar+arXiv+Crossref）——
 *  通用网页引擎对这两类语料天然弱，硬搜只会浪费槽位。 */
export function routeIntents(query: string): { kind: RoutingKind; added: string[]; note: string } {
  const q = String(query ?? '').toLowerCase()
  const code = /\b(github|gitlab|repo|repository|npm|pypi|crate|sdk|library|framework|api|implementation|source code|monorepo)\b/.test(q)
    || /(源码|源代码|代码库|仓库|插件|库|框架|实现方式|依赖)/.test(q)
  const academic = /\b(paper|papers|arxiv|preprint|study|studies|survey|literature|benchmark|dataset)\b/.test(q)
    || /(论文|文献|综述|研究进展|学术|数据集)/.test(q)
  if (code && !academic) return { kind: 'code', added: ['github-repo'], note: '代码/生态类问题 → 追加 GitHub 仓库通道' }
  if (academic && !code) return { kind: 'academic', added: ['academic'], note: '研究类问题 → 追加学术通道（Semantic Scholar/arXiv/Crossref）' }
  if (code && academic) return { kind: 'code', added: ['github-repo', 'academic'], note: '代码＋研究双命中 → 两条专用通道都加' }
  return { kind: 'general', added: [], note: '通用问题 → 只用网页通道' }
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

interface DeepJob {
  engine: string
  t0: number
  /** 通道级异常原文（抛错 / 超预算）——「0 条」的原因。 */
  err?: string
  via?: string
  p: Promise<SearchResult[]>
}

export async function deepResearch(a: DeepArgs): Promise<DeepResult> {
  const primary = a.query.trim()
  const engines = a.engines?.length ? a.engines : ['parallel', 'searxng', 'duckduckgo']
  const queries = fanOutQueries(primary, Math.max(1, Math.min(6, a.variants ?? 4)))
  const maxSources = Math.max(1, Math.min(10, a.maxSources ?? 5))
  const perDomain = Math.max(1, a.perDomain ?? 2)
  const routing = a.routing === 'off'
    ? { kind: 'general' as RoutingKind, added: [] as string[], note: '领域路由已关闭（routing=off）' }
    : routeIntents(primary)
  const stats = { engineCalls: 0, queries: queries.length, sources: 0, fetched: 0, callsPerAnswer: 0, rounds: 1, gapFilled: 0, crossChecked: 0 }
  /** 通道贡献计数：0 = 该通道这一轮没有贡献结果（**静默降级唯一可见的地方**，2026-09-18 事故驱动） */
  const channel: Record<string, number> = {}
  /** 逐通道读数（带原因）——进报告、进工具结果、进 trace。 */
  const channels: ChannelStat[] = []

  const jobs: DeepJob[] = []
  const pushJob = (
    engine: string,
    fn: (mark: (patch: { via?: string; err?: string }) => void) => Promise<SearchResult[]>,
    budgetMs?: number,
  ): void => {
    const t0 = Date.now()
    stats.engineCalls++
    const job: DeepJob = { engine, t0, p: Promise.resolve([]) }
    const mark = (patch: { via?: string; err?: string }) => {
      if (patch.via !== undefined) job.via = patch.via
      if (patch.err !== undefined) job.err = patch.err
    }
    const base = fn(mark).catch((e: any) => {
      job.err = job.err ?? String(e?.message ?? e)
      return [] as SearchResult[]
    })
    job.p = budgetMs
      ? Promise.race([
          base,
          sleep(budgetMs).then(() => {
            job.err = job.err ?? `deadline(${budgetMs}ms)`
            return [] as SearchResult[]
          }),
        ])
      : base
    jobs.push(job)
  }
  const sxBudget = (a.searxngReadyTimeoutMs ?? 15_000) + 4_000
  const sxOpts = {
    gate: a.searxngGate,
    readyTimeoutMs: a.searxngReadyTimeoutMs,
    keepAliveMinutes: a.searxngKeepAliveMinutes,
  }

  // ① Parallel：一次调用吃下整组扇出（它的形状天生支持多查询）——最省调用
  if (engines.includes('parallel')) {
    pushJob('parallel', () => searchParallel(primary, 12, {
      objective: a.objective ?? primary,
      sessionId: a.sessionId,
      extraQueries: queries.slice(1),
    }))
  }
  // ② 自托管 SearXNG：对主查询 + 前两条变体各查一次（本机、零成本；就绪门并发共享同一次带起）
  if (engines.includes('searxng')) {
    for (const q of queries.slice(0, 3)) {
      pushJob('searxng', (mark) => searchSearxng(q, a.searxngBase, 10, {
        ...sxOpts,
        onDiag: (d) => mark({ via: d.via, ...(d.error ? { err: d.error } : {}) }),
      }), sxBudget)
    }
  }
  // ③ 其余免费引擎：只查主查询（保底，不放大调用数）
  const others = engines.filter((e) => e !== 'parallel' && e !== 'searxng')
  if (others.length) {
    pushJob(others.join('+'), () => searchWeb({
      query: primary,
      engines: others,
      tavilyKey: a.tavilyKey,
      serperKey: a.serperKey,
      searxngBase: a.searxngBase,
    }, (s) => {
      // 子通道读数带前缀进同一张表（`web:duckduckgo`）——聚合里的「谁空手」也能读出来
      channels.push({ ...s, engine: `web:${s.engine}` })
    }))
  }
  // ④ 领域路由（2026-09-18 第二轮）：代码类问题 → GitHub 仓库；研究类 → 学术三源
  if (routing.added.includes('github-repo')) {
    pushJob('github-repo', () => searchGithub(primary, 'repo', a.githubToken, 8))
  }
  if (routing.added.includes('academic')) {
    pushJob('academic', () => searchAcademic(primary, undefined, 8))
  }

  const settled = await Promise.all(jobs.map((j) => j.p))
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
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]
    if (!job) continue
    const list = settled[i] ?? []
    channel[job.engine] = (channel[job.engine] ?? 0) + list.length
    channels.push({
      engine: job.engine,
      ok: job.err === undefined,
      count: list.length,
      ms: Date.now() - job.t0,
      ...(job.via !== undefined ? { via: job.via } : {}),
      ...(job.err !== undefined ? { error: job.err } : {}),
    })
    mergeInto(list)
  }

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
      const more: { engine: string; list: SearchResult[] }[] = []
      if (engines.includes('parallel')) {
        stats.engineCalls++
        more.push({
          engine: 'parallel',
          list: await searchParallel(primary, 12, {
            objective: a.objective ?? primary,
            sessionId: a.sessionId,
            extraQueries: gapQueries,
          }).catch(() => []),
        })
      }
      if (engines.includes('searxng')) {
        for (const q of gapQueries.slice(0, 2)) {
          stats.engineCalls++
          more.push({ engine: 'searxng', list: await searchSearxng(q, a.searxngBase, 10, sxOpts).catch(() => []) })
        }
      }
      for (const m of more) {
        channel[m.engine] = (channel[m.engine] ?? 0) + m.list.length
        mergeInto(m.list)
      }
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
  // 多引擎交叉验证（2026-09-18 第二轮）：同一 URL 被 ≥2 条通道命中 ⇒ **相互独立地印证**
  // （单引擎独苗可能是 SEO 噪声；交叉命中是廉价的可信度信号——不是真理，只是排序与阅读的提示）
  stats.crossChecked = sources.filter((s) => s.engines.length >= 2).length

  const lines: string[] = []
  lines.push(`## 深研：${primary}`)
  lines.push(`扇出查询（${queries.length}）：${queries.map((q) => '`' + q + '`').join(' · ')}`)
  lines.push(`领域路由：**${routing.kind}** → ${routing.added.length ? routing.added.join(' + ') : '（仅网页通道）'}（${routing.note}）`)
  lines.push(`引擎调用 ${stats.engineCalls} 次 → 唯一来源 ${sources.length} 条（抓正文 ${stats.fetched} 条 · **多引擎一致 ${stats.crossChecked} 条**）`)
  lines.push(
    `通道贡献：${Object.entries(channel)
      .map(([k, v]) => `${k}=${v}${v === 0 ? '（⚠ 本轮未响应/空手）' : ''}`)
      .join(' · ')}`,
  )
  // 逐通道读数（带原因）：0 条时必须能读出「为什么 0」（VM 未起 / 容器未起 / 超预算 / 上游全挂）
  if (channels.length) {
    lines.push(
      `通道读数：${channels
        .map((c) => `${c.engine}=${c.ok ? 'ok' : 'fail'}:${c.count}@${c.ms}ms${c.via ? `/${c.via}` : ''}${c.error ? `（${c.error.slice(0, 140)}）` : ''}`)
        .join(' · ')}`,
    )
  }
  lines.push('')
  if (!sources.length) {
    lines.push('_无结果：所有引擎都空手而归。先查引擎是否可用（search_quota / searxng 实例），再判定「真的没有」。_')
  }
  for (const s of sources) {
    lines.push(`**[${s.n}] ${s.title}**`)
    lines.push(`- ${s.url}`)
    lines.push(`- 命中引擎：${s.engines.join(', ')}${s.engines.length >= 2 ? ' ★多引擎一致' : ''}`)
    if (s.excerpt) lines.push(`- 摘录：${s.excerpt}`)
    if (s.content) lines.push(`- 正文片段：${s.content.slice(0, 600)}${s.content.length > 600 ? '…' : ''}`)
    lines.push('')
  }
  lines.push('> 引用纪律：以上每条都带可复核 URL；报告里的每个断言都应指向某个 [n]。抓不到正文的条目只作线索，不作结论。★＝≥2 条通道独立命中（可信度提示，不是真理）。')

  return { ok: true, query: primary, queries, report: lines.join('\n'), sources, stats, channels, routing }
}
