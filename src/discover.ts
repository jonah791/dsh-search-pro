/**
 * 纯函数层：多源 URL 发现的解析与规整（无 IO，可离线测）。
 *
 * 设计依据（2026-10-16 借鉴 lc/gau 的 provider 架构）：
 *   每个发现源一个 parse 函数 → 统一成 DiscoveredUrl → 去重规整
 *   ⇒ 加一个新源 = 加一个 parse 函数 + 一个 fetch 函数，不改上层
 *
 * 判据纪律：解析器必须能**响亮失败**（返回 errors 而非静默空），
 * 因为「源返回 0 条」与「源解析失败」是两件事（§5.10 静默失败）。
 */

/** 一条被发现出来的 URL */
export interface DiscoveredUrl {
  url: string
  /** 来源标识（commoncrawl / wayback / otx / crtsh / sitemap / crawl …） */
  source: string
  /** HTTP 状态（源提供时） */
  status?: string
  /** MIME 类型（源提供时） */
  mime?: string
  /** 时间戳（源提供时） */
  ts?: string
}

/** 单个源的解析结果 */
export interface ParseResult {
  urls: DiscoveredUrl[]
  /** 非空 = 该源解析出错（不许静默空手） */
  error?: string
}

const ATTACHMENT_EXT: Record<string, string> = {
  pdf: 'pdf', doc: 'doc', docx: 'docx', xls: 'xls', xlsx: 'xlsx',
  ppt: 'ppt', pptx: 'pptx', csv: 'csv', txt: 'txt', rtf: 'rtf',
  odt: 'odt', ods: 'ods', odp: 'odp', zip: 'zip', rar: 'rar', '7z': '7z',
  epub: 'epub', wps: 'wps', et: 'et', dps: 'dps',
}

const SKIP_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tif', 'tiff',
  'css', 'js', 'mjs', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'map',
  'mp3', 'mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm', 'ogg', 'wav',
])

/** 从 URL 取小写扩展名（无则空串）；忽略 query/hash */
export function extOf(url: string): string {
  const clean = url.split('#')[0]?.split('?')[0] ?? ''
  const last = clean.split('/').pop() ?? ''
  const dot = last.lastIndexOf('.')
  if (dot <= 0 || dot === last.length - 1) return ''
  const ext = last.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : ''
}

/** 明确的文档类 MIME（用于「URL 无扩展名但其实是附件」的漏判补全） */
const ATTACHMENT_MIME =
  /^(application\/(pdf|msword|rtf|epub\+zip|vnd\.openxmlformats-officedocument|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.oasis\.opendocument)|text\/csv)/i

/** 站点协议/元数据文件：名字像附件但不是内容附件（实测 robots.txt 会被误判，2026-10-16） */
const META_FILES = new Set([
  'robots.txt', 'sitemap.xml', 'sitemap.txt', 'sitemap.xml.gz',
  'security.txt', 'humans.txt', 'ads.txt', 'llms.txt', 'manifest.json',
])

export function isMetaFile(url: string): boolean {
  const clean = (url.split('#')[0] ?? '').split('?')[0] ?? ''
  const last = (clean.split('/').pop() ?? '').toLowerCase()
  return META_FILES.has(last)
}

/**
 * 该 URL 是否指向可下载的附件文档（发现层最有价值的一类）。
 * 扩展名或 MIME 任一命中即可——实测 Common Crawl 里有相当比例的附件 URL
 * 不带扩展名，只看扩展名会漏（2026-10-16）。
 */
export function isAttachment(url: string, mime?: string): boolean {
  if (isMetaFile(url)) return false
  if (mime && ATTACHMENT_MIME.test(mime.trim())) return true
  const e = extOf(url)
  return e !== '' && e in ATTACHMENT_EXT
}

/** 该 URL 是否应被丢弃（静态资源/媒体，对文本检索无价值） */
export function isJunk(url: string): boolean {
  const e = extOf(url)
  return e !== '' && SKIP_EXT.has(e)
}

/**
 * 解析 Common Crawl CDX 的 JSONL 响应。
 * 每行一个 JSON 对象；`{"error": "..."}` 形态表示源侧报错。
 */
export function parseCommonCrawl(text: string): ParseResult {
  const urls: DiscoveredUrl[] = []
  const lines = text.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      // 非 JSON 行（例如 504 的 HTML）⇒ 判为源故障，不静默吞掉
      if (line.includes('<html') || line.includes('Gateway Time-out')) {
        return { urls, error: 'commoncrawl 返回非 JSON（疑似 504 网关超时）' }
      }
      continue
    }
    if (obj && typeof obj.error === 'string') {
      return { urls, error: `commoncrawl 源侧错误: ${obj.error}` }
    }
    const u = obj?.url
    if (typeof u !== 'string' || !u) continue
    urls.push({
      url: u,
      source: 'commoncrawl',
      status: typeof obj.status === 'string' ? obj.status : undefined,
      mime: typeof obj.mime === 'string' ? obj.mime : undefined,
      ts: typeof obj.timestamp === 'string' ? obj.timestamp : undefined,
    })
  }
  return { urls }
}

/**
 * 解析 Wayback CDX 的 JSON 数组响应。
 * 首行是表头（`[["urlkey","timestamp",...]]`），按表头索引取值。
 */
export function parseWaybackCdx(text: string): ParseResult {
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    return { urls: [], error: 'wayback 返回非 JSON（archive.org 在大陆网络常被墙）' }
  }
  if (!Array.isArray(data) || data.length === 0) return { urls: [] }
  const header: string[] = Array.isArray(data[0]) ? data[0].map((h: any) => String(h)) : []
  const idx = (name: string) => header.indexOf(name)
  const iUrl = idx('original')
  const iTs = idx('timestamp')
  const iSt = idx('statuscode')
  const iMime = idx('mimetype')
  const urls: DiscoveredUrl[] = []
  for (const row of data.slice(1)) {
    if (!Array.isArray(row)) continue
    const u = iUrl >= 0 ? row[iUrl] : undefined
    if (typeof u !== 'string' || !u) continue
    urls.push({
      url: u,
      source: 'wayback',
      ts: iTs >= 0 && typeof row[iTs] === 'string' ? row[iTs] : undefined,
      status: iSt >= 0 && typeof row[iSt] === 'string' ? row[iSt] : undefined,
      mime: iMime >= 0 && typeof row[iMime] === 'string' ? row[iMime] : undefined,
    })
  }
  return { urls }
}

/** 解析 AlienVault OTX 的 passive_dns 响应（取 hostname 字段） */
export function parseOtx(text: string): ParseResult {
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    return { urls: [], error: 'otx 返回非 JSON' }
  }
  const rows = data?.passive_dns
  if (!Array.isArray(rows)) return { urls: [], error: 'otx 响应缺少 passive_dns 数组' }
  const urls: DiscoveredUrl[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const host = r?.hostname
    if (typeof host !== 'string' || !host || seen.has(host)) continue
    seen.add(host)
    urls.push({ url: `https://${host}/`, source: 'otx', ts: typeof r?.first === 'string' ? r.first : undefined })
  }
  return { urls }
}

/** 解析 crt.sh 的 JSON 数组响应（取 name_value，一行可能有多个换行分隔的域） */
export function parseCrtsh(text: string): ParseResult {
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    return { urls: [], error: 'crtsh 返回非 JSON' }
  }
  if (!Array.isArray(data)) return { urls: [], error: 'crtsh 响应不是数组' }
  const urls: DiscoveredUrl[] = []
  const seen = new Set<string>()
  for (const r of data) {
    const nv = r?.name_value
    if (typeof nv !== 'string') continue
    for (const part of nv.split('\n')) {
      const host = part.trim().toLowerCase()
      if (!host || host.startsWith('*') || seen.has(host)) continue
      seen.add(host)
      urls.push({ url: `https://${host}/`, source: 'crtsh' })
    }
  }
  return { urls }
}

/** 从 HTML 里抽 sitemap / feed / 附件链接（发现层的站点内入口） */
export function extractDiscoveryLinks(html: string, baseUrl: string): {
  sitemaps: string[]
  feeds: string[]
  attachments: string[]
} {
  const sitemaps = new Set<string>()
  const feeds = new Set<string>()
  const attachments = new Set<string>()
  const hrefRe = /(?:href|src)\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = hrefRe.exec(html)) !== null) {
    const raw = m[1]
    if (!raw || raw.startsWith('data:') || raw.startsWith('javascript:')) continue
    let abs: string
    try {
      abs = new URL(raw, baseUrl).toString()
    } catch {
      continue
    }
    const lower = abs.toLowerCase()
    // 顺序有意义：feed 判据更具体，必须先于 sitemap 的 `.xml` 宽判据——
    // 否则 feed.xml / atom.xml 会被当成 sitemap 吞掉（2026-10-16 测试抓出）
    if (/\/(rss|atom|feed)(\/|\.|\?|$)/.test(lower) || /\.(rss|atom)(\?|#|$)/.test(lower)) { feeds.add(abs); continue }
    if (/sitemap/i.test(lower) || /\.xml(\.gz)?(\?|#|$)/.test(lower)) { sitemaps.add(abs); continue }
    if (isAttachment(abs)) attachments.add(abs)
  }
  return { sitemaps: [...sitemaps], feeds: [...feeds], attachments: [...attachments] }
}

/** 规整 + 去重（同 URL 保留首个来源，但记录全部来源） */
export function normalizeDiscovered(items: DiscoveredUrl[]): DiscoveredUrl[] {
  const byUrl = new Map<string, DiscoveredUrl & { sources?: string[] }>()
  for (const it of items) {
    let key = it.url
    try {
      const u = new URL(it.url)
      u.hash = ''
      // http/https 归一：发现的目的是「知道有什么」，协议差异对发现无意义。
      // 实测 Common Crawl 同一页面会同时给 http:// 与 https:// 两条 ⇒ 不归一出双份噪音。
      if (u.protocol === 'http:') u.protocol = 'https:'
      key = u.toString()
    } catch {
      // 非法 URL 原样保留（不静默丢）
    }
    const prev = byUrl.get(key)
    if (!prev) {
      byUrl.set(key, { ...it, url: key })
      continue
    }
    const list = prev.sources ?? [prev.source]
    if (!list.includes(it.source)) list.push(it.source)
    prev.sources = list
    // 补齐缺失的元数据（后面的源可能有 status/mime）
    if (!prev.status && it.status) prev.status = it.status
    if (!prev.mime && it.mime) prev.mime = it.mime
    if (!prev.ts && it.ts) prev.ts = it.ts
  }
  return [...byUrl.values()]
}

/** 汇总统计（进结论的读数必须现算） */
export function discoverStats(items: DiscoveredUrl[], errors: Record<string, string>) {
  const perSource: Record<string, number> = {}
  let attachments = 0
  for (const it of items) {
    perSource[it.source] = (perSource[it.source] ?? 0) + 1
    if (isAttachment(it.url, it.mime)) attachments += 1
  }
  return {
    total: items.length,
    attachments,
    perSource,
    errors,
    errorCount: Object.keys(errors).length,
  }
}
