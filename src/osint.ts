/** 隐秘信息检索：代码敏感信息（Sourcegraph）/ 暗网索引（Ahmia）/ 泄露密码自查（HIBP）
 *  边界：只检索公开信息（公开代码库 / 公开暗网索引 / 公开泄露数据库），用于 OSINT 与安全自查，不协助入侵或针对他人攻击。
 */

import { createHash } from 'node:crypto'
import { httpGet, stripTags, dedupe, UA } from './util.js'

export interface CodeResult {
  repository: string
  path: string
  line: string
  lineNumber: number
  stars: number
  url: string
  language?: string
}

export interface DarkResult {
  title: string
  url: string
  snippet: string
  source: string
}

export interface LeakResult {
  hash: string
  prefix: string
  count: number
  leaked: boolean
}

/** Sourcegraph 代码搜索（免费流式 API，无需 key）：
 *  搜 GitHub 等公开仓库代码——找硬编码密钥/凭据/内部域名等敏感信息。
 *  SSE 流：`event: matches` 块内含 repository/path/lineMatches 数组。
 */
export async function searchCode(query: string, maxResults = 15): Promise<CodeResult[]> {
  const q = `context:global ${query}`.trim()
  const url = `https://sourcegraph.com/.api/search/stream?q=${encodeURIComponent(q)}&display=${maxResults}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  let body: string
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/event-stream', 'User-Agent': UA },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for sourcegraph`)
    body = await res.text()
  } finally {
    clearTimeout(timer)
  }

  const out: CodeResult[] = []
  // SSE 事件块：event: <type>\ndata: <json>
  const blocks = body.split(/\n\n|\r\n\r\n/)
  for (const blk of blocks) {
    if (!/event:\s*matches/i.test(blk)) continue
    const dataLine = blk.split('\n').find((l) => l.startsWith('data: '))
    if (!dataLine) continue
    let arr: any[]
    try {
      arr = JSON.parse(dataLine.slice(6))
    } catch {
      continue
    }
    for (const m of Array.isArray(arr) ? arr : []) {
      const lms: any[] = m?.lineMatches ?? []
      const repo: string = m?.repository ?? ''
      const path: string = m?.path ?? ''
      for (const lm of lms.slice(0, 2)) {
        const line: string = lm?.line ?? ''
        const lineNumber: number = lm?.lineNumber ?? 0
        if (!repo || !path || !line) continue
        out.push({
          repository: repo,
          path,
          line: line.trim().slice(0, 160),
          lineNumber,
          stars: Number(m?.repoStars ?? 0),
          url: `https://sourcegraph.com/${repo}/-/blob/${path}`,
          language: m?.language,
        })
        if (out.length >= maxResults) break
      }
      if (out.length >= maxResults) break
    }
    if (out.length >= maxResults) break
  }
  return out
}

/**
 * Ahmia 暗网索引搜索（clearnet 版，无需 Tor）：
 *  Ahmia 是 Tor 隐藏服务（.onion）的公开索引——搜标题/描述，返回真实 .onion 地址。
 *  先 GET 首页取 CSRF token（hidden input），再带 token 搜索。
 */
export async function searchDarkweb(query: string, maxResults = 15): Promise<DarkResult[]> {
  const home = await httpGet('https://ahmia.fi/', { timeoutMs: 12000 })
  // CSRF token：<input type="hidden" name="<tokenName>" value="<tokenValue>">
  const hidden = home.match(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]+)"/i)
    ?? home.match(/<input[^>]*name="([^"]+)"[^>]*type="hidden"[^>]*value="([^"]+)"/i)
  const tokenName = hidden?.[1]
  const tokenValue = hidden?.[2]
  const params = new URLSearchParams({ q: query })
  if (tokenName && tokenValue) params.set(tokenName, tokenValue)
  const html = await httpGet(`https://ahmia.fi/search/?${params.toString()}`, {
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    timeoutMs: 20000,
  })

  const out: DarkResult[] = []
  // 结果块：<li class="result">… <a href="/search/redirect?search_term=..&redirect_url=<onion>"> <h4>title</h4> <p>desc</p>
  const blocks = html.split(/<li class="result">/i).slice(1)
  for (const b of blocks) {
    const a = b.match(/<a[^>]*href="([^"]*redirect_url=([^"&]+)[^"]*)"[^>]*>/i)
      ?? b.match(/<a[^>]*href="(http[^"]+\.onion[^"]*)"[^>]*>/i)
    if (!a?.[1]) continue
    let url: string
    if (a[2]) {
      try { url = decodeURIComponent(a[2]) } catch { url = a[2] }
    } else {
      url = a[1]
    }
    const title = stripTags(b.match(/<h4>([\s\S]*?)<\/h4>/i)?.[1] ?? '')
    const desc = stripTags(b.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '')
    if (!title && !url) continue
    out.push({
      title: title || url,
      url,
      snippet: desc.slice(0, 200) || '（无描述）',
      source: 'ahmia',
    })
  }
  return dedupe(out, (r) => r.url).slice(0, maxResults)
}

/**
 * HIBP Pwned Passwords 泄露自查（k-anonymity 设计，免费无需 key）：
 *  只传 SHA-1 前 5 位，服务端返回全部匹配后缀+出现次数——查某密码是否出现在已知数据泄露中。
 *  用于安全自查（自己的密码/测试密码），不接收批量他人数据。
 */
export async function checkPasswordLeak(password: string): Promise<LeakResult> {
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase()
  const prefix = sha1.slice(0, 5)
  const suffix = sha1.slice(5)
  const text = await httpGet(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { 'Accept': 'text/plain' },
    timeoutMs: 12000,
  })
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    const [suf, cnt] = line.split(':')
    if (suf && suf.toUpperCase() === suffix) {
      count = Number(cnt ?? 0)
      break
    }
  }
  return { hash: sha1, prefix, count, leaked: count > 0 }
}
