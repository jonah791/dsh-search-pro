/** L1 表层检索：DuckDuckGo / Bing / Tavily / Serper 多引擎 */

import { httpGet, httpPostJSON, decodeDdgUrl, decodeBingUrl, stripTags, normalizeUrl, dedupe, UA } from './util.js'

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

export interface SearchWebArgs {
  query: string
  engines?: string[] // duckduckgo|bing|brave|tavily|serper
  lang?: string
  pages?: number
  tavilyKey?: string
  serperKey?: string
  /** 时间过滤（只对 duckduckgo 生效）：'w'/'m'/'y'（周/月/年）或 'YYYY-MM-DD..YYYY-MM-DD'（绝对区间） */
  timeRange?: string
}

/** 多引擎聚合搜索：并行调用 → 去重 → 按页数扩充 */
export async function searchWeb(args: SearchWebArgs): Promise<SearchResult[]> {
  // 默认 duckduckgo + brave（两个免费无 key 引擎，互为兜底；DDG 反爬时 Brave 顶住）
  const engines = args.engines?.length ? args.engines : ['duckduckgo', 'brave']
  const pages = Math.max(1, Math.min(3, args.pages ?? 1))
  const all: SearchResult[] = []
  const jobs: Promise<SearchResult[]>[] = []

  for (const e of engines) {
    if (e === 'duckduckgo') jobs.push(searchDuckDuckGo(args.query, 10 * pages, { timeRange: args.timeRange }).catch(() => []))
    else if (e === 'bing') jobs.push(searchBing(args.query, 10 * pages).catch(() => []))
    else if (e === 'brave') jobs.push(searchBrave(args.query, 10 * pages).catch(() => []))
    else if (e === 'tavily' && args.tavilyKey) jobs.push(searchTavily(args.query, args.tavilyKey, 8).catch(() => []))
    else if (e === 'serper' && args.serperKey) jobs.push(searchSerper(args.query, args.serperKey, 10).catch(() => []))
  }
  const settled = await Promise.all(jobs)
  for (const rs of settled) all.push(...rs)

  return dedupe(all, (r) => normalizeUrl(r.url))
}
