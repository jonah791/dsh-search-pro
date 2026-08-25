/** 分享资源检索：网盘（百度/阿里/夸克）site 定向 + 磁力链接（Torznab API / HTML 索引站 / DHT 全网） */

import { execFile } from 'node:child_process'
import { httpGet, stripTags, normalizeUrl, dedupe, UA, sleep } from './util.js'

export interface ShareResult {
  title: string
  url: string
  snippet: string
  source: string
  /** 磁力链接（magnet: 开头）——仅磁力结果有 */
  magnet?: string
  /** 种子大小人类可读 */
  size?: string
  /** 做种数（磁力） */
  seeders?: string
}

/** 网盘域名清单：百度（索引最全）/ 阿里云盘两个域名 / 夸克 */
const NETDISK_DOMAINS = [
  'pan.baidu.com',
  'aliyundrive.com',
  'alipan.com',
  'pan.quark.cn',
]

/**
 * 网盘资源搜索：多源并行——
 * ① 学霸盘（xuebapan.com）：百度网盘资源索引站，列表页直接给标题/文件/大小 + 详情页提取码
 * ② site: 定向（DDG，对百度网盘域名有效，DDG 反爬时会失败——作为兜底源）
 */
export async function searchNetdisk(
  query: string,
  domains: string[] = NETDISK_DOMAINS,
  maxResults = 20,
): Promise<ShareResult[]> {
  const jobs: Promise<ShareResult[]>[] = [
    searchXuebapan(query, maxResults).catch(() => [] as ShareResult[]),
  ]
  // site: 定向只在明确指定网盘域名时并行（避免每次打 DDG 触发反爬）
  if (domains.length && domains.some((d) => d.includes('pan.baidu'))) {
    jobs.push(searchBaiduSite(query, maxResults).catch(() => [] as ShareResult[]))
  }
  const settled = await Promise.all(jobs)
  return dedupe(settled.flat(), (r) => r.url || r.title).slice(0, maxResults)
}

/** 学霸盘：搜索列表页 + 详情页提取码（百度网盘资源索引） */
async function searchXuebapan(query: string, maxResults = 20): Promise<ShareResult[]> {
  const listHtml = await httpGet(
    `https://www.xuebapan.com/s/${encodeURIComponent(query)}-1.html`,
    { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } },
  )
  const out: ShareResult[] = []
  // 结果条目：<div class="resource-item-wrap valid"> … <a href="/info/<hash>.html">标题</a>
  const items = listHtml.split(/<div[^>]*class="resource-item-wrap/i).slice(1)
  for (const it of items) {
    const a = it.match(/<a[^>]*class="valid"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      ?? it.match(/<a[^>]*href="(\/info\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    const href = a?.[1]
    if (!a || !href) continue
    const detailUrl = href.startsWith('/') ? `https://www.xuebapan.com${href}` : href
    const title = stripTags(a[2] ?? '')
    // 文件列表 + 大小（detail-item-wrap 内）
    const files = [...it.matchAll(/class="detail-item-title">([\s\S]*?)<\/span>\s*<span>\s*([\s\S]*?)<\/span>/gi)]
      .map((m) => `${stripTags(m[1] ?? '')} (${stripTags(m[2] ?? '')})`)
      .slice(0, 5)
    const size = it.match(/文件大小[^0-9]*([\d.]+ ?[MGTP]?B)/i)?.[1]
      ?? it.match(/<span>\s*([\d.]+ ?[MGTP]?B)\s*<\/span>/i)?.[1]
      ?? ''
    // 详情页取提取码（pwd 字段）
    let pwd = ''
    try {
      const detail = await httpGet(detailUrl, { timeoutMs: 8000 })
      pwd = detail.match(/<span[^>]*id="pwd"[^>]*>([\s\S]*?)<\/span>/i)?.[1]?.trim() ?? ''
    } catch { /* 提取码拿不到不阻塞 */ }
    out.push({
      title,
      url: detailUrl,
      snippet: [files.length ? `文件: ${files.join(' · ')}` : '', size ? `大小 ${size}` : '', pwd ? `提取码 ${pwd}` : '', '详情页有下载入口'].filter(Boolean).join('；'),
      source: 'xuebapan',
    })
    if (out.length >= maxResults) break
  }
  return out
}

/** 百度网盘 site: 定向搜索（DDG，可能触发反爬返回空——优雅降级） */
async function searchBaiduSite(query: string, maxResults = 10): Promise<ShareResult[]> {
  const html = await httpGet(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:pan.baidu.com ${query}`)}`,
    { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' } },
  )
  const out: ShareResult[] = []
  const blocks = html.split(/<div[^>]*class="[^"]*result[^"]*"/i)
  for (const b of blocks.slice(1)) {
    const a = b.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!a?.[1]) continue
    const raw = a[1].includes('uddg=')
      ? decodeURIComponent((a[1].match(/[?&]uddg=([^&]+)/)?.[1] ?? '').replace(/\+/g, ' '))
      : a[1].startsWith('//') ? 'https:' + a[1] : a[1]
    const url = normalizeUrl(raw)
    if (!url.includes('pan.baidu.com')) continue
    if (url.includes('duckduckgo.com/y.js') || url.includes('ad_domain')) continue
    const sn = b.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? ''
    out.push({ title: stripTags(a[2] ?? ''), url, snippet: stripTags(sn), source: 'netdisk:pan.baidu.com' })
    if (out.length >= maxResults) break
  }
  return out
}

/** 解析 Torznab RSS/XML：<item> 提取标题/磁力/大小/seeders */
function parseTorznab(xml: string, source: string): ShareResult[] {
  const items = xml.split(/<item>/i).slice(1)
  const out: ShareResult[] = []
  for (const it of items) {
    const title = it.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ''
    const link = it.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? ''
    const sizeRaw = it.match(/<size>([\s\S]*?)<\/size>/i)?.[1] ?? it.match(/<enclosure[^>]*length="([^"]*)"/i)?.[1] ?? ''
    const seeds = it.match(/<torznab:attr name="seeders" value="([^"]*)"/i)?.[1]
      ?? it.match(/<torznab:attr[^>]*name="seeders"[^>]*value="([^"]*)"/i)?.[1]
      ?? ''
    const peers = it.match(/<torznab:attr name="peers" value="([^"]*)"/i)?.[1]
      ?? it.match(/<torznab:attr[^>]*name="peers"[^>]*value="([^"]*)"/i)?.[1]
      ?? ''
    if (!title || !link) continue
    const magnet = link.startsWith('magnet:') ? link : ''
    out.push({
      title: stripTags(title),
      url: magnet || normalizeUrl(link),
      snippet: seeds ? `种子 ${seeds} · 下载者 ${peers}` : '磁力/种子链接',
      source,
      ...(magnet ? { magnet } : {}),
      ...(sizeRaw ? { size: formatBytes(sizeRaw) } : {}),
      ...(seeds ? { seeders: seeds } : {}),
    })
  }
  return out
}

/** 磁力搜索主源：Torlock Torznab API（免费、无 key、标准 RSS） */
export async function searchMagnetTorlock(query: string, maxResults = 15): Promise<ShareResult[]> {
  const xml = await httpGet(
    `https://www.torlock.com/torznab/api?t=search&q=${encodeURIComponent(query)}&cat=4000`,
    { headers: { 'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' } },
  )
  return parseTorznab(xml, 'torlock').slice(0, maxResults)
}

/** 经 WSL curl 抓取（绕 BTDig 的 UA/TLS 限流：Chrome 精确 UA 触发 429 挑战页，简单 UA + curl 指纹稳定 200） */
function curlGet(url: string, timeoutMs = 20000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'bash', '-lc', `curl -sL --max-time ${Math.floor(timeoutMs / 1000)} -A 'Mozilla/5.0' '${url}'`],
      { windowsHide: true, timeout: timeoutMs + 5000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)),
    )
  })
}

/**
 * 磁力搜索 DHT 全网源：BTDig（btdig.com）——索引 DHT 网络全网种子，
 * 能搜到 Torlock/TPB 等站点索引不到的冷门/版权资源。结果页直接带 magnet 链接（含 dn 标题 + tracker）。
 * BTDig 按 TLS 指纹（JA3）对 Node fetch 限流（429），走 WSL curl 通道（curl 指纹稳定 200）。
 */
export async function searchMagnetBtdig(query: string, maxResults = 15): Promise<ShareResult[]> {
  // BTDig 对 %20 编码 URL 返回 429 挑战页，对 + 分隔的形式正常——用 + 组装查询
  const q = encodeURIComponent(query).replace(/%20/g, '+')
  const html = await curlGet(`https://btdig.com/search?q=${q}`)
  const out: ShareResult[] = []
  // 结果块：<div class="one_result">… <a href="/<hash>/slug">title</a> + magnet 链接
  const blocks = html.split('class="one_result"').slice(1)
  for (const b of blocks) {
    const magnet = b.match(/(magnet:\?xt=urn:btih:[0-9a-fA-F]{40})/)?.[1]
      ?? b.match(/href="(magnet:\?xt=[^"]+)"/i)?.[1]
    const a = b.match(/class="torrent_name"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!magnet && !a?.[1]) continue
    const title = stripTags(a?.[2] ?? '')
    const size = b.match(/class="torrent_size"[^>]*>([^<]*)<\/span>/i)?.[1]?.trim() ?? ''
    const age = b.match(/class="torrent_age"[^>]*>([^<]*)<\/span>/i)?.[1]?.trim() ?? ''
    const files = b.match(/class="torrent_files"[^>]*>([^<]*)<\/span>/i)?.[1]?.trim() ?? ''
    const detailUrl = a?.[1] ? (a[1].startsWith('http') ? a[1] : `https://btdig.com${a[1]}`) : ''
    out.push({
      title: title || magnet?.match(/[?&]dn=([^&]+)/)?.[1]?.replace(/\+/g, ' ') || '未命名种子',
      url: magnet || detailUrl,
      snippet: [
        files ? `文件 ${files}` : '',
        size ? `大小 ${size}` : '',
        age ? age : '',
        magnet ? 'DHT 全网种子' : '',
      ].filter(Boolean).join(' · '),
      source: 'btdig',
      ...(magnet ? { magnet } : {}),
    })
    if (out.length >= maxResults) break
  }
  return out
}

/** 磁力搜索备用源：The Pirate Bay HTML（页面搜索，提取磁力链接） */
export async function searchMagnetTpb(query: string, maxResults = 15): Promise<ShareResult[]> {
  const html = await httpGet(`https://thepiratebay.org/search.php?q=${encodeURIComponent(query)}`)
  const out: ShareResult[] = []
  // TPB 行：<a class="detName"...>Title</a> + 磁力链接在 detLink 内
  const rows = html.split(/<tr>/i).slice(1)
  for (const row of rows) {
    const magnet = row.match(/href="(magnet:\?xt=[^"]+)"/i)?.[1]
    const title = row.match(/class="detName"[^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?? row.match(/<a[^>]*class="[^"]*detName[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?? ''
    if (!magnet || !title) continue
    const sn = row.match(/class="detDesc"[^>]*>([\s\S]*?)<\/font>/i)?.[1] ?? ''
    out.push({
      title: stripTags(title),
      url: magnet,
      snippet: stripTags(sn),
      source: 'tpb',
      magnet,
    })
    if (out.length >= maxResults) break
  }
  return out
}

/** 磁力搜索聚合：多源并行，去重（按 infohash） */
export async function searchMagnet(query: string, maxResults = 15): Promise<ShareResult[]> {
  const jobs = [
    searchMagnetTorlock(query, maxResults).catch(() => [] as ShareResult[]),
    searchMagnetTpb(query, maxResults).catch(() => [] as ShareResult[]),
    searchMagnetBtdig(query, maxResults).catch(() => [] as ShareResult[]),
  ]
  const settled = await Promise.all(jobs)
  const merged = dedupe(settled.flat(), (r) => {
    const m = r.magnet?.match(/urn:btih:([0-9a-fA-F]{40})/i)?.[1]
    return m ? m.toLowerCase() : r.url
  })
  return merged.slice(0, maxResults)
}

/** 字节数 → 人类可读 */
function formatBytes(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return raw
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}
