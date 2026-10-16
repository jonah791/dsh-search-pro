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

/**
 * 检查 WSL 内 Tor 状态 —— **分两级**（2026-10-16 实测修正）
 *
 * ⚠ 旧版只问一个问题「check.torproject.org 通不通」，于是把「**daemon 在跑但这一跳不通**」
 *   报成「daemon 未运行」，并给出「sudo service tor start」这种**错误处方**。
 *   实测：本机 tor daemon 正常、SocksPort 在监听、部分目标可抓（6–24s），
 *   唯独 check.torproject.org 稳定失败 ⇒ 整条通道被误判为「不可用」而遭放弃。
 *
 * ⇒ 拆成两个独立事实，各自可证伪：
 *   · daemon —— SocksPort 是否在监听（本地事实，廉价，不依赖外网）
 *   · circuit —— 经它能否真的取到内容（行为事实，需外网）
 * 两者都不许互相冒充。
 */
export async function torStatus(): Promise<{ ok: boolean; detail: string; daemon: boolean; circuit: boolean }> {
  const sh = (script: string, timeoutMs: number) =>
    new Promise<string>((resolve, reject) => {
      execFile('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', script], { windowsHide: true, timeout: timeoutMs },
        (err, stdout) => (err ? reject(err) : resolve(stdout)))
    })

  // ① daemon：SocksPort 有没有在听（不问外网）
  let daemon = false
  try {
    const out = await sh(`ss -ltn 2>/dev/null | grep -c '127.0.0.1:9050'`, 8000)
    daemon = out.trim() !== '0' && out.trim() !== ''
  } catch { daemon = false }

  // ② circuit：行为判据 —— 取出口 IP（快、稳、语义明确）
  let circuit = false
  let exitIp = ''
  try {
    const out = await sh(`curl -s --max-time 35 --socks5-hostname 127.0.0.1:9050 https://api.ipify.org`, 45000)
    exitIp = out.trim()
    circuit = /^\d{1,3}(\.\d{1,3}){3}$/.test(exitIp)
  } catch { circuit = false }

  const ok = daemon && circuit
  const detail = ok
    ? `Tor 可用：SocksPort 在听 · 出口 ${exitIp}`
    : !daemon
      ? 'Tor 不可用：WSL 内 SocksPort 9050 无监听（daemon 未起）'
      : `Tor 降级：daemon 在跑但出网失败（出口未取得）——多为网桥握手失败/电路残缺；` +
        `查 \`journalctl -u tor -n 20 | grep 'unable to connect'\`（网桥 vs 上游代理）`
  return { ok, detail, daemon, circuit }
}
