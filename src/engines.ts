/** L1 表层检索：DuckDuckGo / Bing / Tavily / Serper 多引擎 */

import { httpGet, httpPostJSON, decodeDdgUrl, decodeBingUrl, stripTags, normalizeUrl, dedupe, UA } from './util.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

/** 从 WSL 内部 curl（复用 `fetch_tor` 的通道纪律）。
 *  为什么需要：宿主是 Windows，而自托管 SearXNG 跑在 WSL 的 host 网络里——
 *  实测 Windows 侧 `http://127.0.0.1:8888` 直接 **连接失败（curl 000）**，
 *  而同一条 URL 在 WSL 内是 200 ⇒ 直连失败时必须落回 WSL 通道（2026-09-18 实测）。 */
async function wslCurl(url: string, timeoutSec = 20): Promise<string> {
  const safe = url.replace(/'/g, '%27')
  // 2026-09-18 实测矩阵（同一 URL，Windows 侧 Node 进程）：
  //   ✅ 裸 `wsl.exe` + 剥代理 env + `curl --noproxy '*'` + 管道 stdio → **10 条 / 867 ms**
  //   ❌ 绝对路径 `C:\WINDOWS\System32\wsl.exe` → 0 条
  //   ❌ 写文件 + UNC(`\\wsl.localhost\Ubuntu…`) 读回（绕开管道 stdio）→ 0 条
  //   ⇒ 保留唯一被证明可用的那一种；web 进程内仍为 0（见语义文档 U10：疑与 web 进程的 spawn 上下文有关）
  const cmd =
    `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy ` +
    `curl -s --noproxy '*' -m ${timeoutSec} '${safe}'`
  const { stdout } = await execFileAsync('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', cmd], {
    timeout: (timeoutSec + 6) * 1000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
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
 *  实例未起时不阻塞：调用方 catch → 空数组，其它引擎照样出结果。 */
export async function searchSearxng(
  query: string,
  baseUrl = 'http://127.0.0.1:8888',
  maxResults = 10,
  opts: { categories?: string; language?: string } = {},
): Promise<SearchResult[]> {
  const root = String(baseUrl).replace(/\/+$/, '')
  const qs = new URLSearchParams({ q: query, format: 'json', safesearch: '0' })
  if (opts.categories) qs.set('categories', opts.categories)
  if (opts.language) qs.set('language', opts.language)
  const url = `${root}/search?${qs.toString()}`
  let raw = ''
  try {
    raw = await httpGet(url, { timeoutMs: 20000 })
  } catch {
    // Windows→WSL 直连失败（实测 curl 000）⇒ 试 WSL 内 curl。
    // ⚠ 2026-09-18 实测：宿主侧 `wsl.exe … bash -lc "curl …"` 返回**空**
    //   （wsl.exe 会重解析 argv，安全传参需要 base64 通道）⇒ 本 fallback 目前不可靠，见语义文档 U10。
    try {
      raw = await wslCurl(url)
    } catch {
      return []
    }
  }
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    return [] // 空体 / HTML / 端口占用一律按「本通道无结果」→ 由上层「通道贡献」行如实报 0
  }
  const results = Array.isArray(data?.results) ? data.results : []
  return results
    .slice(0, maxResults)
    .map((r: any) => ({
      title: String(r.title ?? ''),
      url: normalizeUrl(String(r.url ?? '')),
      snippet: String(r.content ?? '').slice(0, 400),
      source: `searxng${Array.isArray(r.engines) && r.engines.length ? ':' + r.engines.join('+') : ''}`,
    }))
    .filter((r: SearchResult) => r.url)
}

export interface SearchWebArgs {
  query: string
  engines?: string[] // duckduckgo|bing|brave|tavily|serper|parallel|searxng
  lang?: string
  pages?: number
  tavilyKey?: string
  serperKey?: string
  /** SearXNG 自托管实例根地址（默认 http://127.0.0.1:8888） */
  searxngBase?: string
  /** Parallel：自然语言「要找什么」（缺省＝query）与稳定会话 id（免费档限速按它算） */
  objective?: string
  sessionId?: string
  /** Parallel：随主查询一起扇出的补充查询（≤3 条） */
  extraQueries?: string[]
  /** 时间过滤（只对 duckduckgo 生效）：'w'/'m'/'y'（周/月/年）或 'YYYY-MM-DD..YYYY-MM-DD'（绝对区间） */
  timeRange?: string
}

/** 多引擎聚合搜索：并行调用 → 去重 → 按页数扩充 */
export async function searchWeb(args: SearchWebArgs): Promise<SearchResult[]> {
  // 默认四通道：parallel（无钥匙·密集摘录）+ searxng（自托管底座）+ duckduckgo/brave（免费兜底）。
  // 实测（2026-09-18 带标注评测）：只挂 parallel 时 engineCoverage 是 **parallel-only**（单点）；
  // 把自托管 searxng 拉进默认组，聚合里才有第二条活通道
  const engines = args.engines?.length ? args.engines : ['parallel', 'searxng', 'duckduckgo', 'brave']
  const pages = Math.max(1, Math.min(3, args.pages ?? 1))
  const all: SearchResult[] = []
  const jobs: Promise<SearchResult[]>[] = []

  for (const e of engines) {
    if (e === 'duckduckgo') jobs.push(searchDuckDuckGo(args.query, 10 * pages, { timeRange: args.timeRange }).catch(() => []))
    else if (e === 'bing') jobs.push(searchBing(args.query, 10 * pages).catch(() => []))
    else if (e === 'brave') jobs.push(searchBrave(args.query, 10 * pages).catch(() => []))
    else if (e === 'tavily' && args.tavilyKey) jobs.push(searchTavily(args.query, args.tavilyKey, 8).catch(() => []))
    else if (e === 'serper' && args.serperKey) jobs.push(searchSerper(args.query, args.serperKey, 10).catch(() => []))
    else if (e === 'parallel') jobs.push(searchParallel(args.query, 10 * pages, { objective: args.objective, sessionId: args.sessionId, extraQueries: args.extraQueries }).catch(() => []))
    else if (e === 'searxng') jobs.push(searchSearxng(args.query, args.searxngBase, 10 * pages).catch(() => []))
  }
  // 扇出也对自托管引擎生效：补充查询走 searxng（本机零成本，最多 2 条，避免放大调用数）
  if (engines.includes('searxng') && args.extraQueries?.length) {
    for (const q of args.extraQueries.slice(0, 2)) {
      jobs.push(searchSearxng(q, args.searxngBase, 10).catch(() => []))
    }
  }
  const settled = await Promise.all(jobs)
  for (const rs of settled) all.push(...rs)

  return dedupe(all, (r) => normalizeUrl(r.url))
}
