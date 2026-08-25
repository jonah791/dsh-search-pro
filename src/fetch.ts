/** E 组 · 内容处理：正文提取（Jina→自抓→兜底）+ Tor SOCKS 抓取 */

import { execFile } from 'node:child_process'
import { httpGet, htmlToText, stripTags, UA } from './util.js'

export interface FetchResult {
  url: string
  title: string
  content: string
  mode: string
  source: string
}

/** Jina Reader：URL → Markdown 正文（免费额度） */
async function jinaRead(url: string, key?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {}
    if (key) headers.Authorization = `Bearer ${key}`
    const text = await httpGet(`https://r.jina.ai/${encodeURIComponent(url)}`, { headers, timeoutMs: 30000 })
    return text.slice(0, 12000)
  } catch {
    return null
  }
}

/** 简单标题提取 */
function extractTitle(html: string): string {
  return stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
}

/** 正文提取（三级降级：Jina → 自抓+启发式提取） */
export async function fetchPage(url: string, mode: 'reader' | 'raw' = 'reader', jinaKey?: string): Promise<FetchResult> {
  if (mode === 'raw') {
    const html = await httpGet(url, { timeoutMs: 20000 })
    return { url, title: extractTitle(html), content: html.slice(0, 20000), mode: 'raw', source: 'direct' }
  }
  // reader 模式：先 Jina
  if (!/\.onion$/i.test(new URL(url).hostname)) {
    const jina = await jinaRead(url, jinaKey)
    if (jina) return { url, title: jina.split('\n')[0]?.slice(0, 120) ?? '', content: jina, mode: 'reader', source: 'jina' }
  }
  // 降级：直接抓 HTML + 启发式提取
  const html = await httpGet(url, { timeoutMs: 20000 })
  return { url, title: extractTitle(html), content: htmlToText(html), mode: 'reader', source: 'local-extract' }
}

/** 经 WSL curl 走 Tor SOCKS5 抓取（零 Node 依赖；tor daemon 跑在 WSL 内） */
export async function fetchTor(url: string, mode: 'reader' | 'raw' = 'reader', timeoutMs = 40000): Promise<FetchResult> {
  let result: { stdout: string; stderr: string }
  try {
    result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        'wsl.exe',
        ['-d', 'Ubuntu', '--', 'bash', '-lc', `curl -sL --max-time ${Math.floor(timeoutMs / 1000)} --socks5-hostname 127.0.0.1:9050 -A '${UA}' '${url}'`],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 },
        (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve({ stdout, stderr }))
      )
    })
  } catch (e) {
    throw new Error(`Tor 网络不可达（${url}）：请确认 WSL 内 tor 已启动（sudo service tor start）且已建立电路；若目录被墙需配置网桥。底层: ${e instanceof Error ? e.message : e}`)
  }
  const raw = result.stdout
  if (!raw.trim()) throw new Error(`Tor 抓取返回空（${url}）：可能超时或站点不可达`)
  if (mode === 'raw') {
    return { url, title: extractTitle(raw), content: raw.slice(0, 20000), mode: 'raw', source: 'tor' }
  }
  return { url, title: extractTitle(raw), content: htmlToText(raw), mode: 'reader', source: 'tor' }
}

/** 检查 WSL 内 Tor daemon 是否可达 */
export async function torStatus(): Promise<{ ok: boolean; detail: string }> {
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'bash', '-lc', `curl -s --max-time 10 --socks5-hostname 127.0.0.1:9050 https://check.torproject.org/ | grep -o 'Congratulations' | head -1`],
      { windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr }))
    )
  })
  const ok = result.stdout.trim() === 'Congratulations'
  return ok
    ? { ok: true, detail: 'Tor 出口可达（check.torproject.org 通过）' }
    : { ok: false, detail: 'Tor 不可达：wsl 内 tor daemon 未运行或 SOCKS 9050 未监听（安装: sudo apt install tor && sudo service tor start）' }
}
