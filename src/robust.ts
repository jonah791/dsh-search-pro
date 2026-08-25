/** 反爬绕过（anti-anti-scraping）：诊断 + 多通道降级抓取
 *  边界：只用于绕过搜索引擎/公开站点的自动化访问限制（DDG anomaly、429 限流、JS challenge 页），
 *  用于公开信息检索；不用于绕过付费墙、认证、或侵入性用途。
 *
 *  通道链（逐级降级）：
 *  L0 指纹伪装直连（完整浏览器 headers）→ L1 cookie 预热 → L2 退避重试 → L3 headless Chrome 执行 JS challenge
 */

import { execFile } from 'node:child_process'
import { httpGet, stripTags, htmlToText, UA } from './util.js'

export type ChallengeType = 'ip-block' | 'js-challenge' | 'rate-limit' | 'waf' | 'none' | 'unknown'

export interface RobustResult {
  url: string
  content: string
  title: string
  /** 最终命中的通道：fingerprint|prewarm|retry|headless|direct */
  channel: string
  /** 检测到的反爬类型（无则为 none） */
  challenge: ChallengeType
  /** 各通道尝试记录 */
  attempts: { channel: string; status: string; ok: boolean }[]
}

/** 完整浏览器指纹 headers（防 UA/header 检测） */
export function buildBrowserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    ...extra,
  }
}

/** 检测反爬类型
 *  强特征词（挑战页专属，几乎不会出现在正常正文）→ 全文扫描；
 *  弱特征词（可误伤正文，如 anomaly/unusual traffic）→ 只扫 title+头部。
 */
export function detectChallenge(html: string, status: number): ChallengeType {
  if (status === 429) return 'rate-limit'
  const head = html.slice(0, 8000).toLowerCase()
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.toLowerCase() ?? ''
  const headAll = head + '\n' + title
  // 强特征：全文（含 headless 渲染后正文）
  const full = html.toLowerCase()
  const strong = (...pats: string[]) => pats.some((p) => full.includes(p))
  const has = (...pats: string[]) => pats.some((p) => headAll.includes(p))

  // 强特征优先：这些词在正常页面几乎不存在
  if (strong('verifying your browser', 'just a moment', 'checking your browser', 'attention required', 'challenge-platform', 'cf-chl', '不是机器人', '拖动滑块', 'slide to verify', 'drag the slider', 'are you a robot', 'robot check')) {
    return status === 403 || status === 202 || status === 503 || status === 200 ? 'js-challenge' : 'js-challenge'
  }
  if (strong('unusual traffic', 'automated access', 'access from your network', 'we have been receiving a large volume')) {
    return 'ip-block'
  }
  if (strong('security checkpoint')) return 'waf'

  if (status === 403 || status === 202 || status === 503) {
    if (has('captcha', 'recaptcha', 'hcaptcha')) return 'js-challenge'
    if (has('access denied', 'forbidden')) return 'waf'
    if (title.includes('anomaly') && has('duckduckgo', 'captcha', 'challenge')) return 'ip-block'
    if (title.includes('attention required') || title.includes('403 forbidden')) return 'waf'
  }
  if (status === 200) {
    if (title.includes('anomaly') && has('duckduckgo')) return 'ip-block'
  }
  return status >= 400 ? 'unknown' : 'none'
}

/** L0 指纹伪装直连抓取（完整浏览器 headers），返回原始文本 */
async function fetchFingerprint(url: string, timeoutMs = 15000): Promise<{ text: string; status: number }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: buildBrowserHeaders(),
      redirect: 'follow',
      signal: ctrl.signal,
    })
    const text = await res.text()
    return { text, status: res.status }
  } finally {
    clearTimeout(timer)
  }
}

/** L1 cookie 预热：先访问同源首页攒 cookie，再带 cookie 请求目标 */
async function fetchWithPrewarm(url: string, timeoutMs = 15000): Promise<{ text: string; status: number }> {
  const cookies: string[] = []
  const origin = new URL(url).origin
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const home = await fetch(origin + '/', { headers: buildBrowserHeaders(), redirect: 'follow', signal: ctrl.signal })
    clearTimeout(timer)
    const setCookies = home.headers.getSetCookie?.() ?? []
    for (const c of setCookies) {
      const name = c.split('=')[0]?.trim()
      if (name && !name.includes(' ')) cookies.push(c.split(';')[0] ?? '')
    }
    await home.body?.cancel().catch(() => {})
  } catch { /* 预热失败不阻塞 */ }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: buildBrowserHeaders(cookies.length ? { Cookie: cookies.join('; ') } : {}),
      redirect: 'follow',
      signal: ctrl.signal,
    })
    const text = await res.text()
    return { text, status: res.status }
  } finally {
    clearTimeout(timer)
  }
}

/** L2 退避重试：429/5xx 时按 1.5s/4s/8s 退避重试 */
async function fetchWithRetry(url: string, timeoutMs = 15000): Promise<{ text: string; status: number }> {
  let last: { text: string; status: number } = { text: '', status: 0 }
  const backoffs = [1500, 4000, 8000]
  for (let i = 0; i <= backoffs.length; i++) {
    last = await fetchFingerprint(url, timeoutMs)
    if (last.status !== 429 && last.status < 500) return last
    if (i < backoffs.length) await new Promise((r) => setTimeout(r, backoffs[i]))
  }
  return last
}

/** L3 headless Chrome dump-dom：执行 JS challenge 后输出 DOM */
async function fetchHeadless(url: string): Promise<{ text: string; status: number }> {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  let chrome = ''
  for (const c of candidates) {
    try {
      const { accessSync } = await import('node:fs')
      accessSync(c)
      chrome = c
      break
    } catch { /* 下一个 */ }
  }
  if (!chrome) throw new Error('未找到 Chrome/Edge（headless 通道不可用）')
  const userData = `${process.env.TEMP || 'C:\\Windows\\Temp'}\\dsh-robust-${Date.now()}`
  return new Promise<{ text: string; status: number }>((resolve, reject) => {
    execFile(
      chrome,
      [
        '--headless=new', '--dump-dom', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        `--user-data-dir=${userData}`, '--virtual-time-budget=10000', url,
      ],
      { windowsHide: true, timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // 清理临时 profile
        try {
          const { rmSync } = require('node:fs') as typeof import('node:fs')
          rmSync(userData, { recursive: true, force: true })
        } catch { /* 忽略 */ }
        if (err && !stdout) return reject(new Error(`headless 失败: ${stderr || err.message}`))
        // 标题提取判断是否仍是 challenge
        const text = stdout || stderr || ''
        const status = detectChallenge(text, 200) !== 'none' ? 202 : 200
        resolve({ text, status })
      }
    )
  })
}

/** 主入口：多通道降级抓取
 *  skipHeadless=true 时跳过 headless 通道（调用方明确不要）
 */
export async function fetchRobust(url: string, opts: { skipHeadless?: boolean; timeoutMs?: number } = {}): Promise<RobustResult> {
  const attempts: RobustResult['attempts'] = []
  const timeout = opts.timeoutMs ?? 15000

  // L0 指纹直连
  let r = await fetchFingerprint(url, timeout).catch((e) => ({ text: '', status: 0, error: String(e?.message ?? e) }))
  let ch = detectChallenge(r.text ?? '', r.status ?? 0)
  attempts.push({ channel: 'fingerprint', status: `${r.status}${(r as any).error ? ' ' + (r as any).error : ''}`, ok: ch === 'none' })
  if (ch === 'none' && (r.text ?? '').length > 100) {
    return finalize(url, r.text ?? '', 'fingerprint', 'none', attempts)
  }

  // L1 cookie 预热
  r = await fetchWithPrewarm(url, timeout).catch((e) => ({ text: '', status: 0, error: String(e?.message ?? e) }))
  ch = detectChallenge(r.text ?? '', r.status ?? 0)
  attempts.push({ channel: 'prewarm', status: `${r.status}${(r as any).error ? ' ' + (r as any).error : ''}`, ok: ch === 'none' })
  if (ch === 'none' && (r.text ?? '').length > 100) {
    return finalize(url, r.text ?? '', 'prewarm', 'none', attempts)
  }

  // L2 退避重试（429 场景）
  r = await fetchWithRetry(url, timeout).catch((e) => ({ text: '', status: 0, error: String(e?.message ?? e) }))
  ch = detectChallenge(r.text ?? '', r.status ?? 0)
  attempts.push({ channel: 'retry', status: `${r.status}${(r as any).error ? ' ' + (r as any).error : ''}`, ok: ch === 'none' })
  if (ch === 'none' && (r.text ?? '').length > 100) {
    return finalize(url, r.text ?? '', 'retry', 'none', attempts)
  }

  // L3 headless（JS challenge）
  if (!opts.skipHeadless) {
    try {
      const h = await fetchHeadless(url)
      const chH = detectChallenge(h.text, h.status)
      attempts.push({ channel: 'headless', status: `${h.status}`, ok: chH === 'none' })
      if (chH === 'none' && h.text.length > 100) {
        return finalize(url, h.text, 'headless', 'none', attempts)
      }
    } catch (e: any) {
      attempts.push({ channel: 'headless', status: `error: ${e?.message ?? e}`, ok: false })
    }
  }

  // 全部失败：返回最后一次尝试的内容 + 诊断（challenge 类型取最强的一次）
  const chFinal = detectChallenge(r.text ?? '', r.status ?? 0)
  return finalize(url, r.text ?? '', 'failed', chFinal === 'none' ? 'unknown' : chFinal, attempts)
}

/** 组装最终结果 */
function finalize(url: string, html: string, channel: string, challenge: ChallengeType, attempts: RobustResult['attempts']): RobustResult {
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  return {
    url,
    title,
    content: htmlToText(html, 8000),
    channel,
    challenge,
    attempts,
  }
}
