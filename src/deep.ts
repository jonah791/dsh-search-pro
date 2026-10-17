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

/**
 * 检索词 → arxiv 查询表达式。
 *
 * 存在理由（2026-10-17 两次线上实测驱动，两个极端都撞过）：
 * ① **裸空格是 OR**——`deep web crawling hidden web` 实测被查成五个词的 OR，
 *    20 条结果里强相关只有 2 条（10%），无关 15 条（75%）：`Semantic Web` /
 *    `SPARQL Web Preemption` / `Web 3.0` / `City-on-Web`… 全都只是含 "web"。
 * ② 但**整体加引号是过度修正**——把五个词锁成一个精确短语，arxiv 里不存在
 *    这样的论文 ⇒ 从「全污染」跳到「全空」。判据比意图宽（①）或严（②）都是错。
 *
 * 正确形态：**意图由调用者用语法表达，代码不猜**——
 * · 已含 arxiv 语法（字段前缀 `abs:` / 布尔 `AND|OR|ANDNOT` / 引号 / 括号）⇒ 原样透传
 * · 否则多词 ⇒ 逐词 `all:` + `AND` 连接（显式收窄，**绝不产出裸空格**）
 * · 单词 ⇒ 原样
 */
export function arxivQuery(raw: string): string {
  const q = raw.trim()
  if (!q) return q
  if (/[:"()]|\b(?:AND|OR|ANDNOT)\b/.test(q)) return q
  // 去重：`deep web crawling hidden web` 里 web 出现两次 ⇒ 重复的 `all:web` 只是噪音
  const terms = [...new Set(q.split(/\s+/).filter(Boolean))]
  if (terms.length <= 1) return q
  return terms.map((t) => `all:${t}`).join(' AND ')
}

/**
 * arxiv 查询串编码（**不能用 encodeURIComponent**）。
 *
 * 2026-10-17 线上实测 + 官方手册（info.arxiv.org/help/api/user-manual.html §5.1）核对：
 * · `:` 是**字段前缀的语法成分**（`au:del_maestro` / `all:deep`）——`encodeURIComponent`
 *   把它编成 `%3A` ⇒ arxiv 不认前缀、**回退成全文检索** ⇒ 实测 3/3 返回无关论文
 *   （`Manifold DivideMix` / `Backdoor Defenses`，与「深网发现」毫无关系）。
 * · 空格：官方示例一律用 `+`（`search_query=au:del_maestro+AND+ti:checkerboard`）。
 * · 引号是短语检索形态 ⇒ 编成 `%22`。
 *
 * ⚠ 替换顺序：**先编码字面 `+`，最后才把空格换成 `+`**——反了的话用户输入里的
 * 加号会被当分隔符、而空格变成 `%2B`（两次都错）。
 */
export function encodeArxivQuery(q: string): string {
  return q
    .replace(/\+/g, '%2B')
    .replace(/"/g, '%22')
    .replace(/&/g, '%26')
    .replace(/#/g, '%23')
    .replace(/ /g, '+')
}

export async function academicArxiv(
  query: string,
  limit = 8,
  opts: { sortByDate?: boolean; fetcher?: (url: string) => Promise<string> } = {},
): Promise<DeepResult[]> {
  // 四处 2026-10-17 实测修正：
  // ① **https 而非 http**——http 走一次重定向，慢且偶发失败（失败又被上层吞成空数组）
  // ② **查询表达式化**（见 arxivQuery）——裸空格 OR 会灌进 75% 噪音
  // ③ **编码不能用 encodeURIComponent**（见 encodeArxivQuery）——冒号被编码 ⇒ 前缀失效
  // ④ **按提交时间降序**（`sortBy=submittedDate`）——默认是**相关性**排序，产的是
  //    「该主题的经典论文」而不是「新论文」（实测 A/B：默认返回 2012/2016/2019 老论文；
  //    加参数后严格降序 2026→2025→2025→2024→2024，且首条仍是强相关）。
  //    监控场景要的是新论文 ⇒ 由**调用方显式要求**（一次性检索仍可用相关性）。
  const q = encodeArxivQuery(arxivQuery(query))
  const sort = opts.sortByDate ? '&sortBy=submittedDate&sortOrder=descending' : ''
  const get = opts.fetcher ?? httpGet
  const xml = await get(`https://export.arxiv.org/api/query?search_query=${q}${sort}&max_results=${limit}`)
  return parseArxivEntries(xml, limit)
}

/**
 * 解析 arxiv Atom 响应 ⇒ 条目列表。
 *
 * **搜索与定向回填共用这一份**（判据单一真源）：两条路径若各写一套正则，
 * 其中一条改了字段（如 `<published>` 换名）就会**静默**与另一条不一致——
 * 而症状只是「时间未知」，看起来像源没给数据。
 */
export function parseArxivEntries(xml: string, limit: number): DeepResult[] {
  const entries = xml.split(/<entry>/i).slice(1)
  return entries.slice(0, limit).map((e) => {
    const title = stripTags(e.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    const id = e.match(/<id[^>]*>([\s\S]*?)<\/id>/i)?.[1] ?? ''
    const summary = stripTags(e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ?? '').slice(0, 300)
    const published = e.match(/<published[^>]*>([\s\S]*?)<\/published>/i)?.[1]?.slice(0, 10) ?? ''
    return { title, url: id.trim(), snippet: summary, source: 'arxiv', extra: { published } }
  })
}

/**
 * 从 arxiv URL 提取 id（`https://arxiv.org/abs/1612.05413v1` ⇒ `1612.05413v1`）。
 *
 * 只认 `/abs/` 形态（arxiv 的规范条目 URL）；取不到返回 **null（不猜）**——
 * 猜出来的 id 会让 `id_list` 静默返回 0 条，看起来像「源没给时间」，
 * 而真因是「我问错了东西」（§5.9 规则 6：读数必须自带范围标注）。
 */
export function arxivIdFromUrl(url: string): string | null {
  const m = String(url).match(/arxiv\.org\/abs\/([^/?#\s]+)$/i)
  return m?.[1] ?? null
}

/**
 * 按 **arxiv id** 定向取条目（`id_list` 端点）。
 *
 * 为什么需要（2026-10-17 实测）：`pickBackfill` 的有效范围 = 本轮重扫结果 ∩ 库里缺字段条目。
 * 一旦查询变更（`arxiv-deepweb` 三次重建）或源侧排序漂移，这个交集会**归零**
 * ⇒ 旧条目永远补不上时间（实测 23 条全缺，而同 query 未变的另一目标补上了 9 条）。
 * ⇒ 回填不能指望「重扫恰好又返回它」，要按**条目标识**直接问源。
 *
 * `ids` 形如 `1612.05413v1`（**带版本号**：库里 URL 带 vN，要与源返回的 id 对得上，
 * 否则 `fingerprint` 归一后仍不匹配）。
 */
export async function arxivByIds(ids: string[], fetcher?: (url: string) => Promise<string>): Promise<DeepResult[]> {
  if (ids.length === 0) return []
  const get = fetcher ?? httpGet
  const xml = await get(`https://export.arxiv.org/api/query?id_list=${ids.join(',')}&max_results=${ids.length}`)
  return parseArxivEntries(xml, ids.length)
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

/**
 * 学术检索：指定或全部源。
 *
 * `onError` 是**必需的可观测面**（2026-10-17 实测驱动）：原先四个源一律
 * `.catch(() => [])` ⇒ 源失败被读成「扫到 0 条 · state=ok」——**空与失败不分型**，
 * 正是 §5.10 禁的形状（同一晚在情报系统别处修过同款：CC 504 静默缩水）。
 * 现在失败带源名与原因上抛给调用方，由调用方决定报 partial 还是 failed。
 */
export async function searchAcademic(
  query: string,
  source?: AcademicSource,
  limit = 8,
  onError?: (source: AcademicSource, e: unknown) => void,
  // ⚠ 位置参数已到 5 个——下次动这里应合并成 options 对象（现在加第 5 个是为了**不破坏**既有调用方）。
  opts: { arxivSortByDate?: boolean } = {},
): Promise<DeepResult[]> {
  const srcs = source ? [source] : ACADEMIC_SOURCES
  const jobs = srcs.map((s) => {
    const fail = (e: unknown): DeepResult[] => {
      onError?.(s, e)
      return []
    }
    if (s === 'semantic') return academicSemanticScholar(query, limit).catch(fail)
    if (s === 'arxiv') return academicArxiv(query, limit, { ...(opts.arxivSortByDate ? { sortByDate: true } : {}) }).catch(fail)
    if (s === 'crossref') return academicCrossref(query, limit).catch(fail)
    return academicOpenAlex(query, limit).catch(fail)
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
