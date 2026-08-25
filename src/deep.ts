/** L2 深网挖掘：学术 / 专利 / GitHub / 社区 / OSINT 公开 API */

import { httpGet, httpPostJSON, stripTags, normalizeUrl, str, num } from './util.js'
import { searchDuckDuckGo } from './engines.js'

export interface DeepResult {
  title: string
  url: string
  snippet: string
  source: string
  extra?: Record<string, unknown>
}

/* ─────────────── 学术 ─────────────── */

export async function academicSemanticScholar(query: string, limit = 8): Promise<DeepResult[]> {
  const data = await httpGet(
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,url,year,abstract,venue,citationCount,authors.name`
  ).then((t) => JSON.parse(t))
  const items = Array.isArray(data?.data) ? data.data : []
  return items.map((p: any) => ({
    title: str(p.title),
    url: str(p.url) || `https://api.semanticscholar.org/paper/${p.paperId ?? ''}`,
    snippet: (str(p.abstract).slice(0, 300)) || `venue: ${str(p.venue)} · citations: ${num(p.citationCount)} · year: ${p.year ?? ''}`,
    source: 'semantic-scholar',
    extra: { year: p.year, venue: str(p.venue), citations: num(p.citationCount) },
  }))
}

export async function academicArxiv(query: string, limit = 8): Promise<DeepResult[]> {
  const xml = await httpGet(`http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}`)
  const entries = xml.split(/<entry>/i).slice(1)
  return entries.slice(0, limit).map((e) => {
    const title = stripTags(e.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    const id = e.match(/<id[^>]*>([\s\S]*?)<\/id>/i)?.[1] ?? ''
    const summary = stripTags(e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ?? '').slice(0, 300)
    const published = e.match(/<published[^>]*>([\s\S]*?)<\/published>/i)?.[1]?.slice(0, 10) ?? ''
    return { title, url: id.trim(), snippet: summary, source: 'arxiv', extra: { published } }
  })
}

export async function academicCrossref(query: string, limit = 8): Promise<DeepResult[]> {
  const data = await httpGet(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}`).then((t) => JSON.parse(t))
  const items = Array.isArray(data?.message?.items) ? data.message.items : []
  return items.map((p: any) => ({
    title: str(Array.isArray(p.title) ? p.title[0] : p.title),
    url: str(p.URL) || `https://doi.org/${str(p.DOI)}`,
    snippet: `DOI: ${str(p.DOI)} · year: ${p.issued?.['date-parts']?.[0]?.[0] ?? ''} · container: ${str(Array.isArray(p['container-title']) ? p['container-title'][0] : '')}`,
    source: 'crossref',
    extra: { doi: str(p.DOI) },
  }))
}

export async function academicOpenAlex(query: string, limit = 8): Promise<DeepResult[]> {
  const data = await httpGet(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}`).then((t) => JSON.parse(t))
  const items = Array.isArray(data?.results) ? data.results : []
  return items.map((p: any) => ({
    title: str(p.display_name),
    url: p.primary_location?.landing_page_url ?? `https://openalex.org/${p.id ?? ''}`,
    snippet: `cited_by: ${num(p.cited_by_count)} · year: ${p.publication_year ?? ''}`,
    source: 'openalex',
    extra: { cited_by: num(p.cited_by_count), year: p.publication_year },
  }))
}

export type AcademicSource = 'semantic' | 'arxiv' | 'crossref' | 'openalex'
export const ACADEMIC_SOURCES: AcademicSource[] = ['semantic', 'arxiv', 'crossref', 'openalex']

/** 学术检索：指定或全部源 */
export async function searchAcademic(query: string, source?: AcademicSource, limit = 8): Promise<DeepResult[]> {
  const srcs = source ? [source] : ACADEMIC_SOURCES
  const jobs = srcs.map((s) => {
    if (s === 'semantic') return academicSemanticScholar(query, limit).catch(() => [])
    if (s === 'arxiv') return academicArxiv(query, limit).catch(() => [])
    if (s === 'crossref') return academicCrossref(query, limit).catch(() => [])
    return academicOpenAlex(query, limit).catch(() => [])
  })
  const settled = await Promise.all(jobs)
  return settled.flat()
}

/* ─────────────── 专利 ─────────────── */

/** 专利检索：对 Google Patents 做定向搜索（走搜索引擎，稳定无反爬） */
export async function searchPatent(query: string, serperKey?: string, maxResults = 8): Promise<DeepResult[]> {
  const q = `site:patents.google.com ${query}`
  if (serperKey) {
    // 有 key：Serper Google 实时（最准）
    const data = await httpPostJSON('https://google.serper.dev/search', { q, num: maxResults }, { headers: { 'X-API-KEY': serperKey } })
    const organic = Array.isArray(data?.organic) ? data.organic : []
    return organic.map((r: any) => ({ title: str(r.title), url: normalizeUrl(str(r.link)), snippet: str(r.snippet), source: 'google-patents' }))
  }
  // 无 key：DDG 定向（质量优于 Bing），空结果再 Bing 兜底
  const ddg = await searchDuckDuckGo(q, maxResults)
  if (ddg.length) return ddg
  const html = await httpGet(`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${maxResults}`)
  const out: DeepResult[] = []
  const blocks = html.split(/<li class="b_algo"/i)
  for (const b of blocks.slice(1)) {
    const a = b.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i)
    if (!a?.[1]) continue
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? ''
    out.push({ title: stripTags(a[2] ?? ''), url: normalizeUrl(a[1]), snippet: stripTags(p), source: 'google-patents' })
    if (out.length >= maxResults) break
  }
  return out
}

/* ─────────────── GitHub ─────────────── */

export async function searchGithub(query: string, type: 'code' | 'repo' | 'issue', token?: string, limit = 8): Promise<DeepResult[]> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (type === 'code' && !token) {
    throw new Error('GitHub code 搜索需要 githubToken（未认证无法搜索代码）')
  }
  const kind = type === 'repo' ? 'repositories' : type === 'issue' ? 'issues' : 'code'
  const data = await httpGet(
    `https://api.github.com/search/${kind}?q=${encodeURIComponent(query)}&per_page=${limit}`,
    { headers }
  ).then((t) => JSON.parse(t))
  const items = Array.isArray(data?.items) ? data.items : []
  if (type === 'repo') {
    return items.map((r: any) => ({
      title: str(r.full_name),
      url: str(r.html_url),
      snippet: `★${num(r.stargazers_count)} · ${str(r.description).slice(0, 200)}`,
      source: 'github-repo',
      extra: { stars: num(r.stargazers_count), lang: str(r.language) },
    }))
  }
  if (type === 'issue') {
    return items.map((r: any) => ({
      title: str(r.title),
      url: str(r.html_url),
      snippet: `${str(r.repository?.full_name)} · state: ${str(r.state)}`,
      source: 'github-issue',
    }))
  }
  return items.map((r: any) => ({
    title: `${str(r.repository?.full_name)}: ${str(r.name)}`,
    url: str(r.html_url),
    snippet: str(r.path),
    source: 'github-code',
  }))
}

/* ─────────────── 社区 ─────────────── */

/** Reddit：直接 JSON API 已全面 403（需 OAuth），改用 site:reddit.com 定向搜索（免费稳定） */
export async function communityReddit(query: string, limit = 10): Promise<DeepResult[]> {
  const results = await searchDuckDuckGo(`site:reddit.com ${query}`, limit)
  return results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, source: 'reddit' }))
}

export async function communityHackerNews(query: string, limit = 10): Promise<DeepResult[]> {
  const data = await httpGet(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`).then((t) => JSON.parse(t))
  const hits = Array.isArray(data?.hits) ? data.hits : []
  return hits.map((h: any) => ({
    title: str(h.title) || str(h.story_title),
    url: str(h.url) || `https://news.ycombinator.com/item?id=${h.objectID ?? ''}`,
    snippet: `points: ${num(h.points)} · ${str(h.author)} · ${str(h.created_at).slice(0, 10)}`,
    source: 'hackernews',
    extra: { points: num(h.points), author: str(h.author) },
  }))
}

/** 4chan：抓指定 board 的 catalog 过滤关键词 */
export async function communityFourChan(query: string, board = 'g', limit = 10): Promise<DeepResult[]> {
  const data = await httpGet(`https://a.4cdn.org/${board}/catalog.json`).then((t) => JSON.parse(t))
  const out: DeepResult[] = []
  const q = query.toLowerCase()
  for (const page of Array.isArray(data) ? data : []) {
    const threads = Array.isArray(page?.threads) ? page.threads : []
    for (const t of threads) {
      const sub = str(t.sub).toLowerCase()
      const com = str(t.com).toLowerCase()
      if (sub.includes(q) || com.includes(q)) {
        out.push({
          title: str(t.sub) || `thread ${t.no ?? ''}`,
          url: `https://boards.4channel.org/${board}/thread/${t.no ?? ''}`,
          snippet: stripTags(str(t.com)).slice(0, 250),
          source: '4chan',
          extra: { board, replies: num(t.replies) },
        })
        if (out.length >= limit) return out
      }
    }
  }
  return out
}

/** Telegram 公开频道：抓取 t.me/s/<channel> 最近帖子过滤关键词（按 data-post 精准切块） */
export async function communityTelegram(channel: string, query?: string, limit = 10): Promise<DeepResult[]> {
  const html = await httpGet(`https://t.me/s/${encodeURIComponent(channel)}`)
  const out: DeepResult[] = []
  const q = (query ?? '').toLowerCase()
  // 用 data-post 位置切块（避免 tgme_widget_message_* 辅助块干扰）
  const segments: { id: string; start: number }[] = []
  const re = /data-post="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    // 切块起点跳到该 div 标签的 > 之后，避免属性文本残留
    const tagEnd = html.indexOf('>', m.index + m[0].length)
    const start = tagEnd > 0 ? tagEnd + 1 : m.index + m[0].length
    segments.push({ id: m[1] ?? '', start })
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const end = segments[i + 1]?.start ?? html.length
    const text = stripTags(html.slice(seg.start, end)).slice(0, 400)
    if (q && !text.toLowerCase().includes(q)) continue
    out.push({
      title: text.slice(0, 80),
      url: `https://t.me/${seg.id}`,
      snippet: text,
      source: 'telegram',
      extra: { channel },
    })
    if (out.length >= limit) break
  }
  return out
}

export type CommunityPlatform = 'reddit' | 'hn' | '4chan' | 'telegram' | 'tieba'
export const COMMUNITY_PLATFORMS: CommunityPlatform[] = ['reddit', 'hn', '4chan']

/** 社区检索 */
export async function searchCommunity(
  query: string,
  platform?: CommunityPlatform,
  opts: { board?: string; channel?: string } = {},
  limit = 10
): Promise<DeepResult[]> {
  const jobs: Promise<DeepResult[]>[] = []
  const add = (s: CommunityPlatform) => {
    if (s === 'reddit') jobs.push(communityReddit(query, limit).catch(() => []))
    else if (s === 'hn') jobs.push(communityHackerNews(query, limit).catch(() => []))
    else if (s === '4chan') jobs.push(communityFourChan(query, opts.board ?? 'g', limit).catch(() => []))
    else if (s === 'telegram') {
      if (opts.channel) jobs.push(communityTelegram(opts.channel, query, limit).catch(() => []))
    }
  }
  if (platform) add(platform)
  else COMMUNITY_PLATFORMS.forEach(add)
  const settled = await Promise.all(jobs)
  return settled.flat()
}

/* ─────────────── OSINT ─────────────── */

/** RDAP 域名注册信息（免费，无 key） */
export async function lookupWhois(domain: string): Promise<DeepResult> {
  const data = await httpGet(`https://rdap.org/domain/${encodeURIComponent(domain)}`).then((t) => JSON.parse(t))
  const entities = Array.isArray(data?.entities) ? data.entities : []
  const registrant = entities.find((e: any) => (e.roles ?? []).includes('registrant'))
  const nameservers = Array.isArray(data?.nameservers) ? data.nameservers.map((n: any) => str(n.ldhName)).join(', ') : ''
  return {
    title: `RDAP ${domain}`,
    url: `https://rdap.org/domain/${domain}`,
    snippet: `status: ${(data?.status ?? []).join(', ')} · nameservers: ${nameservers}`,
    source: 'rdap',
    extra: {
      handle: str(data?.handle),
      events: (data?.events ?? []).map((e: any) => `${e.eventAction}:${str(e.eventDate).slice(0, 10)}`).join('; '),
      registrant: registrant ? str(registrant.handle) : '',
      ldhName: str(data?.ldhName),
    },
  }
}

/** 子域名枚举：crt.sh 优先，502/失败时 fallback certspotter */
export async function enumSubdomains(domain: string, limit = 30): Promise<DeepResult[]> {
  try {
    return await enumCrtSh(domain, limit)
  } catch (e) {
    try {
      return await enumCertspotter(domain, limit)
    } catch (e2) {
      throw new Error(`crt.sh: ${e instanceof Error ? e.message : e}; certspotter: ${e2 instanceof Error ? e2.message : e2}`)
    }
  }
}

/** crt.sh 子域名枚举（crt.sh 响应慢且偶发 502，给 45s 超时） */
async function enumCrtSh(domain: string, limit = 30): Promise<DeepResult[]> {
  const data = await httpGet(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, { timeoutMs: 45000 }).then((t) => JSON.parse(t))
  const seen = new Set<string>()
  const out: DeepResult[] = []
  for (const c of Array.isArray(data) ? data : []) {
    const names = str(c?.name_value).split('\n')
    for (const n of names) {
      const name = n.trim().replace(/^\*\./, '')
      if (!name || seen.has(name)) continue
      seen.add(name)
      out.push({
        title: name,
        url: `https://${name}`,
        snippet: `issuer: ${str(c?.issuer_name)} · valid to ${str(c?.not_after).slice(0, 10)}`,
        source: 'crt.sh',
        extra: { not_before: str(c?.not_before).slice(0, 10), not_after: str(c?.not_after).slice(0, 10) },
      })
      if (out.length >= limit) return out
    }
  }
  return out
}

/** certspotter 子域名枚举（crt.sh 502 时的 fallback，免费有限额） */
async function enumCertspotter(domain: string, limit = 30): Promise<DeepResult[]> {
  const data = await httpGet(
    `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names`,
    { timeoutMs: 30000 }
  ).then((t) => JSON.parse(t))
  const seen = new Set<string>()
  const out: DeepResult[] = []
  for (const c of Array.isArray(data) ? data : []) {
    const names = Array.isArray(c?.dns_names) ? c.dns_names : []
    for (const n of names) {
      const name = String(n).trim().replace(/^\*\./, '')
      if (!name || seen.has(name)) continue
      seen.add(name)
      out.push({
        title: name,
        url: `https://${name}`,
        snippet: `certspotter: ${str(c?.id)}`,
        source: 'certspotter',
      })
      if (out.length >= limit) return out
    }
  }
  return out
}

/** SecurityTrails DNS 历史（需 key，免费额度） */
export async function lookupDnsHistory(domain: string, key: string): Promise<DeepResult> {
  const data = await httpGet(`https://api.securitytrails.com/v1/history/${encodeURIComponent(domain)}/dns/a`, {
    headers: { APIKEY: key, Accept: 'application/json' },
  }).then((t) => JSON.parse(t))
  const records = Array.isArray(data?.records) ? data.records : []
  const history = records.slice(0, 8).map((r: any) => {
    const ips = (r?.values ?? []).map((v: any) => str(v.ip)).join(', ')
    return `${str(r.first_seen).slice(0, 10)}→${str(r.last_seen).slice(0, 10)}: ${ips}`
  })
  return {
    title: `DNS 历史 ${domain}`,
    url: `https://securitytrails.com/domain/${domain}/dns`,
    snippet: history.join(' | ') || '无 A 记录历史',
    source: 'securitytrails',
    extra: { records: records.length },
  }
}

/** Shodan 暴露服务/设备（需 key，免费额度） */
export async function searchShodan(query: string, key: string, limit = 8): Promise<DeepResult[]> {
  const data = await httpGet(
    `https://api.shodan.io/shardown/search?query=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`
  ).then((t) => JSON.parse(t))
  const matches = Array.isArray(data?.matches) ? data.matches : []
  return matches.slice(0, limit).map((m: any) => ({
    title: `${str(m.ip_str)}:${num(m.port)}`,
    url: `https://www.shodan.io/host/${str(m.ip_str)}`,
    snippet: `org: ${str(m.org)} · product: ${str(m.product)} · hosts: ${(m.hostnames ?? []).join(',')}`,
    source: 'shodan',
    extra: { port: num(m.port), org: str(m.org), product: str(m.product) },
  }))
}
