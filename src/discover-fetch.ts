/**
 * IO 层：多源发现的实际取数（HTTP + 重试 + 礼貌限流）。
 *
 * 与 discover.ts 的分工：那边是纯函数（解析/规整，可离线测），
 * 这边只管「怎么把字节拿回来」——换一个源只动这里，不改上层。
 *
 * 实测依据（2026-10-16 探测）：
 *   · Common Crawl CDX：limit≤50 成功、≥200 稳定 504；page 参数偶发 504（重试有效）
 *     ⇒ 小 limit + 有界重试是**必需**而非优化
 *   · crt.sh：可用，4.5s
 *   · Wayback（web.archive.org）：大陆网络被墙（fetch failed）
 *   · OTX：匿名受限；URLScan：无 key 时 total=0
 */

import { httpGet, sleep } from './util.js'
import {
  parseCommonCrawl,
  parseCrtsh,
  parseWaybackCdx,
  normalizeDiscovered,
  discoverStats,
  isAttachment,
  isMetaFile,
  type ParseResult,
  type DiscoveredUrl,
} from './discover.js'

/** Common Crawl 官方索引清单（给出「有哪些索引可选」） */
export const CC_COLLINFO_URL = 'https://index.commoncrawl.org/collinfo.json'

/** CDX 单次请求的 limit 上限（实测 50 稳、200 必 504） */
export const CC_PAGE_LIMIT = 50

export interface RetryOpts {
  retries?: number
  timeoutMs?: number
  baseDelayMs?: number
}

/** 带界重试的 GET：返回 text 或 error，绝不静默空手 */
export async function getWithRetry(
  url: string,
  opts: RetryOpts = {},
): Promise<{ text?: string; error?: string; attempts: number }> {
  const retries = opts.retries ?? 3
  const timeoutMs = opts.timeoutMs ?? 30000
  const baseDelayMs = opts.baseDelayMs ?? 1000
  let lastErr = ''
  let attempts = 0
  for (let i = 0; i <= retries; i++) {
    attempts++
    try {
      const text = await httpGet(url, { timeoutMs })
      // 网关超时页可能以 200 返回（不同反代行为不一）⇒ 内容形态也要判
      const head = text.slice(0, 200).toLowerCase()
      if (head.includes('gateway time-out') || head.includes('504 gateway')) {
        lastErr = '网关超时（源侧 504）'
      } else {
        return { text, attempts }
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    // 有界退避：第 i 次失败后等 baseDelay*(i+1)，推远下次尝试（§5.17）
    if (i < retries) await sleep(baseDelayMs * (i + 1))
  }
  return { error: lastErr, attempts }
}

/** 取 Common Crawl 可用索引清单（最新在前） */
export async function fetchCcIndexes(opts: RetryOpts = {}): Promise<{ ids: string[]; error?: string }> {
  const r = await getWithRetry(CC_COLLINFO_URL, { timeoutMs: 40000, ...opts })
  if (r.error || !r.text) return { ids: [], error: r.error ?? '空响应' }
  try {
    const arr = JSON.parse(r.text)
    if (!Array.isArray(arr)) return { ids: [], error: 'collinfo 不是数组' }
    return { ids: arr.map((x: any) => String(x?.id ?? '')).filter(Boolean) }
  } catch (e) {
    return { ids: [], error: `collinfo 解析失败: ${e instanceof Error ? e.message : e}` }
  }
}

export interface CcOpts extends RetryOpts {
  /** 查哪些索引（缺省 = 取最新的 indexCount 个） */
  indexes?: string[]
  /** 缺省查几个索引（缺省 3；单索引 limit 上限 50，多索引才扩得开覆盖） */
  indexCount?: number
  /** 每索引取多少条（上限 CC_PAGE_LIMIT） */
  limit?: number
  /** 是否包含子域（matchType=domain 时天然包含） */
  includeSubdomains?: boolean
  /** 并发上限（礼貌：别打爆公共 API） */
  concurrency?: number
}

/** 从 Common Crawl 的若干索引里拉 URL（逐索引串行 + 每索引内有界重试） */
export async function fetchCommonCrawl(
  domain: string,
  opts: CcOpts = {},
): Promise<ParseResult & { perIndex: Record<string, number>; attempts: number }> {
  const limit = Math.min(opts.limit ?? CC_PAGE_LIMIT, CC_PAGE_LIMIT)
  let indexes = opts.indexes ?? []
  const perIndex: Record<string, number> = {}
  let attempts = 0
  if (indexes.length === 0) {
    const got = await fetchCcIndexes(opts)
    if (got.error || got.ids.length === 0) {
      return { urls: [], error: `无法取 CC 索引清单: ${got.error ?? '空'}`, perIndex, attempts }
    }
    // 缺省查最近 N 个索引：单索引 limit 实测上限 50，多索引是扩大覆盖的唯一手段。
    // N=2 是速度与覆盖的折中（3 个索引实测 124s，太重）
    const want = opts.indexCount ?? 2
    indexes = got.ids.slice(0, want)
  }
  const urls: ParseResult['urls'] = []
  const errors: string[] = []
  for (const ix of indexes) {
    // 实测 matchType=domain 成功、url=domain/* 超时 ⇒ 固定用 domain
    const q = new URLSearchParams({
      url: domain,
      matchType: 'domain',
      output: 'json',
      fl: 'url,status,mime,timestamp',
      limit: String(limit),
    })
    const target = `https://index.commoncrawl.org/${ix}-index?${q.toString()}`
    const r = await getWithRetry(target, { timeoutMs: 60000, ...opts })
    attempts += r.attempts
    if (r.error || !r.text) {
      errors.push(`${ix}: ${r.error ?? '空响应'}`)
      perIndex[ix] = 0
      continue
    }
    const parsed = parseCommonCrawl(r.text)
    perIndex[ix] = parsed.urls.length
    if (parsed.error) errors.push(`${ix}: ${parsed.error}`)
    urls.push(...parsed.urls)
    await sleep(400) // 礼貌间隔
  }
  return {
    urls,
    perIndex,
    attempts,
    error: errors.length ? errors.join(' | ') : undefined,
  }
}

/** 从 crt.sh 证书透明日志取子域（无需 key） */
export async function fetchCrtsh(
  domain: string,
  opts: RetryOpts = {},
): Promise<ParseResult> {
  const url = `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`
  const r = await getWithRetry(url, { timeoutMs: 45000, retries: 2, ...opts })
  if (r.error || !r.text) return { urls: [], error: `crt.sh 不可达: ${r.error ?? '空响应'}` }
  return parseCrtsh(r.text)
}

/** 从 Wayback CDX 取 URL（大陆网络常被墙，失败要响亮） */
export async function fetchWayback(
  domain: string,
  opts: RetryOpts & { limit?: number } = {},
): Promise<ParseResult> {
  const q = new URLSearchParams({
    url: domain,
    matchType: 'domain',
    fl: 'original,timestamp,statuscode,mimetype',
    collapse: 'urlkey',
    limit: String(opts.limit ?? 200),
    output: 'json',
  })
  const r = await getWithRetry(`https://web.archive.org/cdx/search/cdx?${q.toString()}`, {
    timeoutMs: 30000,
    retries: 1,
    ...opts,
  })
  if (r.error || !r.text) return { urls: [], error: `wayback 不可达: ${r.error ?? '空响应'}` }
  return parseWaybackCdx(r.text)
}

/** 取 robots.txt：既给 sitemap 线索，也给爬取礼貌规则 */
export async function fetchRobots(
  baseUrl: string,
  opts: RetryOpts = {},
): Promise<{ raw?: string; sitemaps: string[]; disallow: string[]; error?: string }> {
  const base = baseUrl.replace(/\/+$/, '')
  const r = await getWithRetry(`${base}/robots.txt`, { timeoutMs: 15000, retries: 1, ...opts })
  if (r.error || !r.text) return { sitemaps: [], disallow: [], error: r.error ?? '空响应' }
  const text = r.text
  // 反爬/网关页伪装成 200 的情形：robots.txt 不该是 HTML
  if (text.slice(0, 200).toLowerCase().includes('<html')) {
    return { sitemaps: [], disallow: [], error: 'robots.txt 返回 HTML（疑似网关页）' }
  }
  const sitemaps: string[] = []
  const disallow: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0]?.trim() ?? ''
    if (!line) continue
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim().toLowerCase()
    const val = line.slice(i + 1).trim()
    if (key === 'sitemap' && val) sitemaps.push(val)
    else if (key === 'disallow' && val) disallow.push(val)
  }
  return { raw: text, sitemaps: [...new Set(sitemaps)], disallow: [...new Set(disallow)] }
}

/**
 * 猜 sitemap 位置并逐个试（借鉴 trafilatura 的 GUESSES 策略：
 * 先 robots.txt 给的线索，再按「最可能的先试」顺序猜）。
 */
export const SITEMAP_GUESSES = [
  'sitemap.xml',
  'sitemap_index.xml',
  'sitemap.xml.gz',
  'sitemap',
  'sitemap_news.xml',
]

export interface SitemapProbe {
  url: string
  ok: boolean
  bytes: number
  error?: string
}

/** 探测某站点是否存在可用的 sitemap（返回每个候选的实测结果） */
export async function probeSitemaps(
  baseUrl: string,
  hints: string[] = [],
  opts: RetryOpts & { maxProbe?: number } = {},
): Promise<{ probes: SitemapProbe[]; firstText?: string; firstUrl?: string }> {
  const base = baseUrl.replace(/\/+$/, '')
  const maxProbe = opts.maxProbe ?? 5
  const candidates: string[] = []
  for (const h of hints) {
    if (!h) continue
    try {
      candidates.push(new URL(h, base + '/').toString())
    } catch {
      /* 线索非法就跳过，不静默当作没有 */
    }
  }
  for (const g of SITEMAP_GUESSES) candidates.push(`${base}/${g}`)
  const uniq = [...new Set(candidates)].slice(0, maxProbe)
  const probes: SitemapProbe[] = []
  let firstText: string | undefined
  let firstUrl: string | undefined
  for (const u of uniq) {
    const r = await getWithRetry(u, { timeoutMs: 20000, retries: 1, ...opts })
    if (r.error || !r.text) {
      probes.push({ url: u, ok: false, bytes: 0, error: r.error ?? '空响应' })
      continue
    }
    const text = r.text
    const head = text.slice(0, 300).toLowerCase()
    // sitemap 的合法形态：XML（含 <urlset/<sitemapindex）或纯文本 URL 列表
    const isXml = /<\?xml|<(?:[\w.-]+:)?(?:sitemapindex|urlset|sitemap)\b/.test(text.slice(0, 300))
    const looksHtml = head.includes('<html') || head.includes('<!doctype html')
    const ok = isXml || (!looksHtml && /^https?:\/\//m.test(text))
    probes.push({ url: u, ok, bytes: text.length, error: ok ? undefined : '内容不是 sitemap 形态' })
    if (ok && !firstText) {
      firstText = text
      firstUrl = u
    }
  }
  return { probes, firstText, firstUrl }
}

// ── 多源编排 ────────────────────────────────────────────────────────────

export interface DiscoverUrlsOpts extends RetryOpts {
  /** 用哪些源：commoncrawl | crtsh | wayback（缺省前两个，wayback 在大陆常被墙） */
  sources?: string[]
  /** 每源取多少条 */
  limit?: number
  /** CC 索引 id 列表（缺省最新一个） */
  indexes?: string[]
}

export interface DiscoverUrlsResult {
  domain: string
  urls: DiscoveredUrl[]
  /** 只含附件的子集（深网高价值目标） */
  attachments: DiscoveredUrl[]
  stats: ReturnType<typeof discoverStats>
  perSource: Record<string, number>
  perIndex: Record<string, number>
  errors: Record<string, string>
  attempts: number
  elapsedMs: number
}

/** 把用户给的输入规整成裸域名（吃 URL / 带路径 / 带 www 的形态） */
export function normalizeDomain(input: string): string {
  let s = input.trim()
  s = s.replace(/^[a-z]+:\/\//i, '')
  s = s.split('/')[0] ?? s
  s = s.split('?')[0] ?? s
  s = s.replace(/:\d+$/, '')
  return s.toLowerCase()
}

/**
 * 多源 URL 发现主入口（借鉴 lc/gau 的 provider 编排）。
 * 各源并行、互不阻塞；每个源失败都进 errors 而**不拖垮其他源**。
 */
export async function discoverUrls(domain: string, opts: DiscoverUrlsOpts = {}): Promise<DiscoverUrlsResult> {
  const t0 = Date.now()
  const bare = normalizeDomain(domain)
  const sources = opts.sources && opts.sources.length ? opts.sources : ['commoncrawl', 'crtsh']
  const limit = opts.limit ?? CC_PAGE_LIMIT

  const tasks: Array<Promise<{ name: string; res: ParseResult; perIndex?: Record<string, number>; attempts?: number }>> = []
  if (sources.includes('commoncrawl')) {
    tasks.push(
      fetchCommonCrawl(bare, { indexes: opts.indexes, limit, retries: opts.retries, timeoutMs: opts.timeoutMs })
        .then((r) => ({ name: 'commoncrawl', res: { urls: r.urls, error: r.error }, perIndex: r.perIndex, attempts: r.attempts })),
    )
  }
  if (sources.includes('crtsh')) {
    tasks.push(fetchCrtsh(bare, opts).then((res) => ({ name: 'crtsh', res })))
  }
  if (sources.includes('wayback')) {
    tasks.push(fetchWayback(bare, { ...opts, limit: Math.max(limit, 200) }).then((res) => ({ name: 'wayback', res })))
  }

  const settled = await Promise.all(tasks)
  const all: DiscoveredUrl[] = []
  const errors: Record<string, string> = {}
  const perSource: Record<string, number> = {}
  const perIndex: Record<string, number> = {}
  let attempts = 0
  for (const s of settled) {
    perSource[s.name] = s.res.urls.length
    if (s.res.error) errors[s.name] = s.res.error
    if (s.perIndex) Object.assign(perIndex, s.perIndex)
    if (s.attempts) attempts += s.attempts
    all.push(...s.res.urls)
  }

  // 站点协议文件（robots.txt 等）不是「发现目标」，从结果里剔除
  // （源读数 perSource 仍记原始条数，不掩盖源的真实产出）
  const merged = normalizeDiscovered(all).filter((u) => !isMetaFile(u.url))
  const stats = discoverStats(merged, errors)
  return {
    domain: bare,
    urls: merged,
    attachments: merged.filter((u) => isAttachment(u.url, u.mime)),
    stats,
    perSource,
    perIndex,
    errors,
    attempts,
    elapsedMs: Date.now() - t0,
  }
}
