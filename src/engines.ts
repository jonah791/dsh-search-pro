/** L1 表层检索：DuckDuckGo / Bing / Tavily / Serper / Parallel / 自托管 SearXNG */

import { httpGet, httpPostJSON, decodeDdgUrl, decodeBingUrl, stripTags, normalizeUrl, dedupe, sleep, UA } from './util.js'
import { ensureSearxng, formatAttempts, parseSearxngResults, searxngDiagnostics, searxngSearchUrl, simplifyQuery, wslRun } from './searxng.js'

/** 单通道读数（Q3/Q4/Q5 的 per-channel 版本）——由 `searchWeb`/`searchSearxng` 汇给调用方与 trace。 */
export interface ChannelStat {
  engine: string
  ok: boolean
  count: number
  ms: number
  /** 走到哪条路（searxng：`direct` / 冷启步骤链）。 */
  via?: string
  /** 失败原因原文（截断后的 message；**这是上一轮缺的那一半**——「0 条」与「为什么 0 条」）。 */
  error?: string
}
export type ChannelSink = (s: ChannelStat) => void

/** 从 WSL 内部 curl（复用 `fetch_tor` 的通道纪律）。
 *  为什么需要：宿主是 Windows，而自托管 SearXNG 跑在 WSL 的 Docker 里——
 *  直连失败（VM 关机 / 容器未起）时的**最后一条路**。
 *  2026-09-18 实测矩阵（同一 URL，Windows 侧 Node 进程）：
 *   ✅ 裸 `wsl.exe` + 剥代理 env + `curl --noproxy '*'` + 管道 stdio → 10 条 / 867 ms
 *   ❌ 绝对路径 `C:\WINDOWS\System32\wsl.exe` → 0 条；❌ 写文件 + UNC 读回 → 0 条
 *  ⚠ 但 2026-09-18 13:45 定性：VM 关机的**主因**由 `ensureSearxng` 前置解决，本条只作兜底。 */
async function wslCurl(url: string, timeoutSec = 20): Promise<string> {
  const safe = url.replace(/'/g, '%27')
  const cmd =
    `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy ` +
    `curl -s --noproxy '*' -m ${timeoutSec} '${safe}'`
  return wslRun(['-d', 'Ubuntu', '--', 'bash', '-lc', cmd], (timeoutSec + 6) * 1000)
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
  source: string
}

/** DuckDuckGo HTML 接口（免费，无需 key；带限流重试 + 指纹伪装防 anomaly + 时间过滤）
 *  timeRange：DDG 时间过滤 df 参数——'w'/'m'/'y'（周/月/年）或 'YYYY-MM-DD..YYYY-MM-DD'（绝对区间）
 */
export async function searchDuckDuckGo(query: string, maxResults = 10, opts: { timeRange?: string } = {}): Promise<SearchResult[]> {
  let last: SearchResult[] = []
  const timeParam = opts.timeRange ? `&df=${encodeURIComponent(opts.timeRange)}` : ''
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt))
    try {
      // 指纹伪装 headers（Sec-CH-UA / Sec-Fetch-* 全家桶）——实测可破 DDG anomaly（IP 被标记时 202 → 200）
      const headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      }
      const html = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${timeParam}`, { headers })
      const out: SearchResult[] = []
      // 结果块：<div class="result"> ... <a class="result__a" href>Title</a> ... <a class="result__snippet">
      const blocks = html.split(/<div[^>]*class="[^"]*result[^"]*"/i)
      for (const b of blocks.slice(1)) {
        const a = b.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
        if (!a?.[1]) continue
        const url = normalizeUrl(decodeDdgUrl(a[1]))
        if (url.includes('duckduckgo.com/y.js') || url.includes('ad_domain')) continue // 过滤广告
        const sn = b.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? ''
        out.push({
          title: stripTags(a[2] ?? ''),
          url,
          snippet: stripTags(sn),
          source: 'duckduckgo',
        })
        if (out.length >= maxResults) break
      }
      last = out
      if (out.length) return out // 有结果即返回
    } catch {
      /* 重试 */
    }
  }
  return last
}

/** Bing 网页抓取（免费，无需 key） */
export async function searchBing(query: string, maxResults = 10): Promise<SearchResult[]> {
  const html = await httpGet(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults + 5}`)
  const out: SearchResult[] = []
  const blocks = html.split(/<li class="b_algo"/i)
  for (const b of blocks.slice(1)) {
    const a = b.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i)
    if (!a?.[1]) continue
    const p = b.match(/<(?:p|div)[^>]*class="[^"]*(?:b_caption|b_lineclamp)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i)?.[1]
      ?? b.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]
      ?? ''
    out.push({
      title: stripTags(a[2] ?? ''),
      url: normalizeUrl(decodeBingUrl(a[1])),
      snippet: stripTags(p),
      source: 'bing',
    })
    if (out.length >= maxResults) break
  }
  // 新版 Bing 用加密 /ck/a 链接：对前 6 条跟随重定向解析真实 URL
  return resolveBingRedirects(out)
}

/** 跟随 Bing 重定向链接，解析真实目标 URL（前 6 条并行） */
async function resolveBingRedirects(results: SearchResult[]): Promise<SearchResult[]> {
  const targets = results.filter((r) => r.url.includes('/ck/a')).slice(0, 6)
  if (!targets.length) return results
  const resolved = await Promise.all(targets.map(async (r) => {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(r.url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA }, signal: ctrl.signal })
      clearTimeout(timer)
      const final = res.url
      await res.body?.cancel().catch(() => {})
      if (final && !final.includes('/ck/a')) return { ...r, url: normalizeUrl(final) }
    } catch {
      /* 保留原链接 */
    }
    return r
  }))
  const kept = results.filter((r) => !r.url.includes('/ck/a'))
  const rest = results.filter((r) => r.url.includes('/ck/a')).slice(6)
  return [...kept, ...resolved, ...rest]
}

/** Brave 网页抓取（免费，无需 key；HTML 为 Svelte SSR，结果块 class="snippet"） */
export async function searchBrave(query: string, maxResults = 10): Promise<SearchResult[]> {
  const html = await httpGet(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`)
  const out: SearchResult[] = []
  // 结果块：<div class="snippet svelte-xxx" id="infobox-snippet"> 是知识面板（跳过），其余为结果
  const blocks = html.split(/class="snippet svelte-/i).slice(1)
  for (const b of blocks) {
    if (b.startsWith('jmfu5f" id="infobox')) continue // infobox 知识面板
    const a = b.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i)
    if (!a?.[1]) continue
    const url = normalizeUrl(a[1])
    if (url.includes('brave.com') || url.includes('play.google.com') || url.includes('itunes.apple.com')) continue
    // 标题：紧随 URL 的 <a> 内文本（snippet 块开头）
    const title = stripTags(b.slice(0, 600).match(/<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '')
    // 摘要：<p> 或 snippet 文本
    const sn = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]
      ?? b.match(/class="snippet-description[^"]*"[^>]*>([\s\S]*?)</i)?.[1]
      ?? ''
    out.push({ title: title || url, url, snippet: stripTags(sn), source: 'brave' })
    if (out.length >= maxResults) break
  }
  return out
}

/** Tavily API（需 key，免费 1000 次/月） */
export async function searchTavily(query: string, key: string, maxResults = 8): Promise<SearchResult[]> {
  const data = await httpPostJSON('https://api.tavily.com/search', {
    api_key: key,
    query,
    max_results: maxResults,
    search_depth: 'advanced',
    include_answer: false,
  })
  const results = Array.isArray(data?.results) ? data.results : []
  return results.map((r: any) => ({
    title: String(r.title ?? ''),
    url: normalizeUrl(String(r.url ?? '')),
    snippet: String(r.content ?? ''),
    source: 'tavily',
  }))
}

/** Serper Google SERP API（需 key，免费 2500 次） */
export async function searchSerper(query: string, key: string, maxResults = 10): Promise<SearchResult[]> {
  const data = await httpPostJSON('https://google.serper.dev/search', { q: query, num: maxResults }, {
    headers: { 'X-API-KEY': key },
  })
  const organic = Array.isArray(data?.organic) ? data.organic : []
  return organic.map((r: any) => ({
    title: String(r.title ?? ''),
    url: normalizeUrl(String(r.link ?? '')),
    snippet: String(r.snippet ?? ''),
    source: 'serper-google',
  }))
}

/** Parallel Search MCP（**无账号 / 无 key / 无卡** · 2026-09-18 实测可用）
 *  形状＝objective + 一次多查询扇出（≤4 条）+ 稳定 session_id；返回**密集摘录**（excerpts），
 *  一次调用往往即可作答，省掉「先搜再逐页抓」的多跳成本。免费档按 session_id 限速。 */
export async function searchParallel(
  query: string,
  maxResults = 10,
  opts: { objective?: string; sessionId?: string; extraQueries?: string[] } = {},
): Promise<SearchResult[]> {
  const queries = [query, ...(opts.extraQueries ?? [])]
    .map((q) => String(q).trim())
    .filter(Boolean)
    .slice(0, 4)
  const data = await httpPostJSON(
    'https://search.parallel.ai/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'web_search',
        arguments: {
          objective: opts.objective ?? query,
          search_queries: queries,
          session_id: opts.sessionId ?? 'dsh-search-pro',
        },
      },
    },
    { headers: { accept: 'application/json, text/event-stream' }, timeoutMs: 60000 },
  )
  const text = data?.result?.content?.[0]?.text
  if (typeof text !== 'string') return []
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    return []
  }
  const results = Array.isArray(payload?.results) ? payload.results : []
  return results
    .slice(0, maxResults)
    .map((r: any) => ({
      title: String(r.title ?? r.url ?? ''),
      url: normalizeUrl(String(r.url ?? '')),
      snippet: (Array.isArray(r.excerpts) ? r.excerpts.join(' … ') : String(r.snippet ?? '')).slice(0, 600),
      source: 'parallel',
    }))
    .filter((r: SearchResult) => r.url)
}

/** SearXNG 自托管 JSON API（无 key · 只绑本机 127.0.0.1）——零成本底座。
 *  **2026-09-18 第二轮（U10 闭环）**：查询前先过**就绪门** `ensureSearxng`
 *  （探活 → 冷启 VM → 幂等确保容器 → 轮询到就绪；并发扇出共享同一次带起），
 *  每一步读数交给 `onDiag`——「0 条」从此带**为什么**（VM 未起 / 容器未起 / 超预算 / 上游全挂）。 */
export async function searchSearxng(
  query: string,
  baseUrl = 'http://127.0.0.1:18788',
  maxResults = 10,
  opts: {
    categories?: string
    language?: string
    /** 是否过就绪门（默认 true）。 */
    gate?: boolean
    /** 就绪等待预算（ms，默认 15000）。 */
    readyTimeoutMs?: number
    /** 冷启成功后留保活进程（分钟；默认 120，0＝不留）。 */
    keepAliveMinutes?: number
    /** 通道读数回调（Q3：断在哪一段）。 */
    onDiag?: (d: { via: string; ms: number; attempts: string; error?: string }) => void
  } = {},
): Promise<SearchResult[]> {
  const root = String(baseUrl ?? 'http://127.0.0.1:18788').replace(/\/+$/, '')
  const url = searxngSearchUrl(root, query, opts)
  const t0 = Date.now()
  let via = 'direct'
  let gateNote = ''
  if (opts.gate !== false) {
    try {
      const state = await ensureSearxng(root, {
        timeoutMs: opts.readyTimeoutMs ?? 15_000,
        keepAliveMinutes: opts.keepAliveMinutes,
      })
      via = state.ready ? 'direct' : 'none'
      gateNote = state.cached ? 'cached' : formatAttempts(state.attempts)
      // ⚠ 就绪门失败**不再 return []**（2026-09-18 14:2x 实测修正）：门的判据是「Windows 侧直连是否通」，
      //   而通道本身有**两条路**（直连 / WSL 内 curl）。门失败但 VM 已被带起来时，WSL 内 curl 往往就通——
      //   上一版在这里提前返回，等于把唯一可用的第二路也掐了（round1 取证：17 次 poll 全 fetch failed，results=0）。
      if (!state.ready) via = 'gate-failed'
    } catch (e: any) {
      via = 'gate-error'
      gateNote = String(e?.message ?? e)
    }
  }
  // 取数：**空结果重试一次**（2026-09-18 实测：SearXNG 上游引擎会偶发限流返回 0 条——
  // 同一查询隔 1.2s 再问通常就有；第二次用**简化查询**（前 4 词），长查询在上游更难命中/更易撞限流）。
  // 「通道通了但空手」不该被读成「这条路坏了」，也不该让深研报告缺一条腿。
  let raw = ''
  let parsed: ReturnType<typeof parseSearxngResults> = []
  let retried = false
  let retryQuery = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const reqUrl = attempt === 0 ? url : searxngSearchUrl(root, retryQuery || query, opts)
    try {
      raw = await httpGet(reqUrl, { timeoutMs: 20_000 })
    } catch (e: any) {
      const directErr = String(e?.message ?? e)
      try {
        raw = await wslCurl(reqUrl)
        via = via === 'direct' ? 'wsl-curl' : `${via}+wsl-curl`
      } catch (e2: any) {
        opts.onDiag?.({
          via,
          ms: Date.now() - t0,
          attempts: gateNote,
          error: `直连失败(${directErr})；wsl 兜底失败(${String(e2?.message ?? e2)})`,
        })
        return []
      }
    }
    parsed = parseSearxngResults(raw, maxResults)
    if (parsed.length || attempt === 1) break
    retried = true
    retryQuery = simplifyQuery(query)
    await sleep(1200)
  }
  if (parsed.length === 0) {
    const diag = searxngDiagnostics(raw)
    opts.onDiag?.({
      via,
      ms: Date.now() - t0,
      attempts: gateNote,
      error: `0 条（已重试一次${retryQuery ? '＋简化查询' : ''}；unresponsive=${diag.unresponsive.join(',') || '无'}）`,
    })
  } else {
    opts.onDiag?.({
      via,
      ms: Date.now() - t0,
      attempts: gateNote,
      ...(retried ? { error: `首次 0 条、重试后命中${retryQuery ? `（简化查询：${retryQuery}）` : ''}` } : {}),
    })
  }
  return parsed.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, source: r.source }))
}

export interface SearchWebArgs {
  query: string
  engines?: string[] // duckduckgo|bing|brave|tavily|serper|parallel|searxng
  lang?: string
  pages?: number
  tavilyKey?: string
  serperKey?: string
  /** SearXNG 自托管实例根地址（默认 http://127.0.0.1:18788） */
  searxngBase?: string
  /** 是否过 SearXNG 就绪门（默认 true：探活 → 冷启 VM → 确保容器 → 轮询）。 */
  searxngGate?: boolean
  /** 就绪等待预算（ms，默认 15000）。 */
  searxngReadyTimeoutMs?: number
  /** 冷启成功后留保活进程（分钟；默认 120，0＝不留）。 */
  searxngKeepAliveMinutes?: number
  /** searxng 在**本次聚合**里的预算封顶（ms，默认 15000）——超时不拖住其它通道。 */
  searxngBudgetMs?: number
  /** Parallel：自然语言「要找什么」（缺省＝query）与稳定会话 id（免费档限速按它算） */
  objective?: string
  sessionId?: string
  /** Parallel：随主查询一起扇出的补充查询（≤3 条） */
  extraQueries?: string[]
  /** 时间过滤（只对 duckduckgo 生效）：'w'/'m'/'y'（周/月/年）或 'YYYY-MM-DD..YYYY-MM-DD'（绝对区间） */
  timeRange?: string
}

/** 多引擎聚合搜索：并行调用 → 逐通道读数 → 去重。
 *  `sink` 收**每一条通道**的 ok/count/ms/via/error——工具结果与 `search-trace.jsonl` 共用它，
 *  于是「某通道 0 条」不再是一个孤零零的数字，而是带原因的读数（2026-09-18 第二轮）。 */
export async function searchWeb(args: SearchWebArgs, sink?: ChannelSink): Promise<SearchResult[]> {
  // 默认四通道：parallel（无钥匙·密集摘录）+ searxng（自托管底座）+ duckduckgo/brave（免费兜底）。
  // 实测（2026-09-18 带标注评测）：只挂 parallel 时 engineCoverage 是 **parallel-only**（单点）；
  // 把自托管 searxng 拉进默认组，聚合里才有第二条活通道
  const engines = args.engines?.length ? args.engines : ['parallel', 'searxng', 'duckduckgo', 'brave']
  const pages = Math.max(1, Math.min(3, args.pages ?? 1))
  const all: SearchResult[] = []
  const jobs: Promise<SearchResult[]>[] = []

  /** 逐通道跑：成功/失败/超预算各记一条读数（**只报一次**——迟到的成功不再重复记账）。 */
  const runChannel = (
    engine: string,
    fn: () => Promise<SearchResult[]>,
    o: { budgetMs?: number; extra?: () => { via?: string; error?: string } } = {},
  ): Promise<SearchResult[]> => {
    const t = Date.now()
    let reported = false
    const report = (s: { ok: boolean; count: number; error?: string }) => {
      if (reported) return
      reported = true
      const extra = o.extra?.() ?? {}
      sink?.({
        engine,
        ok: s.ok,
        count: s.count,
        ms: Date.now() - t,
        ...(extra.via !== undefined ? { via: extra.via } : {}),
        ...(s.error !== undefined ? { error: s.error } : extra.error !== undefined ? { error: extra.error } : {}),
      })
    }
    const p = fn()
      .then((list) => {
        report({ ok: true, count: list.length })
        return list
      })
      .catch((e: any) => {
        report({ ok: false, count: 0, error: String(e?.message ?? e) })
        return [] as SearchResult[]
      })
    if (!o.budgetMs) return p
    return Promise.race([
      p,
      sleep(o.budgetMs).then(() => {
        report({ ok: false, count: 0, error: `deadline(${o.budgetMs}ms)：通道仍在带起中，本轮不计入（后台继续，稍后调用可命中就绪缓存）` })
        return [] as SearchResult[]
      }),
    ])
  }

  const sxDiag: { via?: string; error?: string } = {}
  const sxExtra = () => sxDiag
  const sxOpts = {
    gate: args.searxngGate,
    readyTimeoutMs: args.searxngReadyTimeoutMs,
    keepAliveMinutes: args.searxngKeepAliveMinutes,
    onDiag: (d: { via: string; error?: string }) => {
      sxDiag.via = d.via
      if (d.error) sxDiag.error = d.error
    },
  }
  const sxBudget = Math.max(2_000, args.searxngBudgetMs ?? 15_000)

  for (const e of engines) {
    if (e === 'duckduckgo') jobs.push(runChannel('duckduckgo', () => searchDuckDuckGo(args.query, 10 * pages, { timeRange: args.timeRange })))
    else if (e === 'bing') jobs.push(runChannel('bing', () => searchBing(args.query, 10 * pages)))
    else if (e === 'brave') jobs.push(runChannel('brave', () => searchBrave(args.query, 10 * pages)))
    else if (e === 'tavily' && args.tavilyKey) jobs.push(runChannel('tavily', () => searchTavily(args.query, args.tavilyKey!, 8)))
    else if (e === 'serper' && args.serperKey) jobs.push(runChannel('serper', () => searchSerper(args.query, args.serperKey!, 10)))
    else if (e === 'parallel') {
      jobs.push(runChannel('parallel', () => searchParallel(args.query, 10 * pages, { objective: args.objective, sessionId: args.sessionId, extraQueries: args.extraQueries })))
    } else if (e === 'searxng') {
      jobs.push(runChannel('searxng', () => searchSearxng(args.query, args.searxngBase, 10 * pages, sxOpts), { budgetMs: sxBudget, extra: sxExtra }))
    }
  }
  // 扇出也对自托管引擎生效：补充查询走 searxng（本机零成本，最多 2 条，避免放大调用数）
  if (engines.includes('searxng') && args.extraQueries?.length) {
    for (const q of args.extraQueries.slice(0, 2)) {
      jobs.push(runChannel('searxng+fanout', () => searchSearxng(q, args.searxngBase, 10, sxOpts), { budgetMs: sxBudget, extra: sxExtra }))
    }
  }
  const settled = await Promise.all(jobs)
  for (const rs of settled) all.push(...rs)

  return dedupe(all, (r) => normalizeUrl(r.url))
}
