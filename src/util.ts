/** 通用工具：HTTP 请求 / HTML 处理 / URL / 去重 */

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export interface HttpOpts {
  headers?: Record<string, string>
  timeoutMs?: number
}

/**
 * 带 UA + 超时的 GET，返回文本。非 2xx 抛错。
 *
 * ⚠ **超时与限速的归因必须分开**（2026-10-17 实测修正）：arxiv 被限速时返回 429，
 * 但**响应耗时 16.2s**（实测）——旧超时 15s ⇒ 在响应到达前就 abort，于是错误信息是
 * 裸的 `This operation was aborted`，**「被限速」被读成「超时」**，归因方向被误导
 * （我会去查网络/超时配置，而真因是限速）。三处修正：
 * ① 超时 15s → **30s**（给慢响应留余量，429 实测 16.2s 能拿到）；
 * ② abort 时给**可读原因**（区分「我掐的」与「对端慢/限速」）；
 * ③ **429 单独成类**（带 `Retry-After`）——它是可退避的，不是故障。
 */
export async function httpGet(url: string, opts: HttpOpts = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30000
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...(opts.headers ?? {}) },
      signal: ctrl.signal,
      redirect: 'follow',
    })
    if (res.status === 429) {
      const ra = res.headers.get('retry-after')
      throw new Error(`HTTP 429 被限速${ra ? `（Retry-After: ${ra}s）` : ''} for ${url}`)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return await res.text()
  } catch (e) {
    // 两种 abort 原因必须分开说——否则「对端慢/限速」与「真超时」同貌（§5.10 语义精确性）
    if (timedOut) throw new Error(`请求超时（${timeoutMs}ms）for ${url}——对端可能限速或响应慢`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 带 UA + 超时的 POST JSON，返回解析后的 JSON。 */
export async function httpPostJSON(url: string, body: unknown, opts: HttpOpts = {}): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 去掉 HTML 标签与多余空白 */
export function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从 HTML 提取可读正文（启发式：优先 main/article，其次全部文本截断） */
export function htmlToText(html: string, maxLen = 8000): string {
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0]
  const article = html.match(/<article[\s\S]*?<\/article>/i)?.[0]
  const body = html.match(/<body[\s\S]*?<\/body>/i)?.[0]
  const src = main ?? article ?? body ?? html
  const text = stripTags(src)
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
}

/** 解码 DuckDuckGo 重定向链接（uddg 参数） */
export function decodeDdgUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/)
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      /* fallthrough */
    }
  }
  return href.startsWith('//') ? 'https:' + href : href
}

/** 解码 Bing 重定向链接（/ck/a 的 u 参数为 base64url 编码的真实 URL） */
export function decodeBingUrl(href: string): string {
  if (!href.includes('/ck/a')) return href
  try {
    const url = new URL(href)
    const u = url.searchParams.get('u')
    if (u) {
      const b64 = u.replace(/^a1/, '')
      const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
      return Buffer.from(b64 + pad, 'base64url').toString('utf8')
    }
  } catch {
    /* fallthrough */
  }
  return href
}

/** 规范化 URL：去 tracking 参数、统一协议 */
export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u)
    url.hash = ''
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'spm', 'fbclid', 'gclid']) {
      url.searchParams.delete(k)
    }
    return url.toString()
  } catch {
    return u
  }
}

/** 按 key 去重 */
export function dedupe<T>(arr: T[], keyFn: (t: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of arr) {
    const k = keyFn(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 从 JSON 响应安全取字符串字段 */
export function str(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt
}

export function num(v: unknown, dflt = 0): number {
  return typeof v === 'number' ? v : dflt
}
