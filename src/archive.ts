/** D 组 · 档案与还原：Wayback Machine CDX + 快照还原 / archive.today */

import { httpGet, htmlToText, str } from './util.js'

export interface ArchiveSnapshot {
  timestamp: string
  url: string
  statuscode: string
}

/** Wayback CDX 快照清单查询（网络不可达时给友好提示） */
export async function cdxSearch(urlOrDomain: string, from?: string, to?: string, limit = 20): Promise<ArchiveSnapshot[]> {
  try {
    const params = new URLSearchParams({
      url: urlOrDomain,
      output: 'json',
      limit: String(limit),
      fl: 'timestamp,original,statuscode',
      filter: 'statuscode:200',
    })
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    const data = await httpGet(`https://web.archive.org/cdx/search/cdx?${params.toString()}`, { timeoutMs: 25000 }).then((t) => JSON.parse(t))
    const rows = Array.isArray(data) ? data.slice(1) : []
    return rows.map((r: any) => ({
      timestamp: str(r?.[0]),
      url: str(r?.[1]),
      statuscode: str(r?.[2]),
    }))
  } catch (e) {
    throw new Error(`web.archive.org 不可达（${e instanceof Error ? e.message : e}）：archive.org 在中国大陆网络常被墙；可待 Tor 出口连通后改用 fetch_tor 访问快照`)
  }
}

/** 快照还原：取目标时间快照并提取正文（网络不可达时给友好提示） */
export async function archiveRestore(url: string, timestamp?: string): Promise<{ snapshot: string; content: string }> {
  try {
    const ts = timestamp ?? (await latestSnapshot(url))
    const target = ts
      ? `https://web.archive.org/web/${ts}id_/${url}`
      : `https://web.archive.org/web/${url}`
    const html = await httpGet(target, { timeoutMs: 30000 })
    return {
      snapshot: ts ? `https://web.archive.org/web/${ts}/${url}` : target,
      content: htmlToText(html),
    }
  } catch (e) {
    throw new Error(`Wayback 还原失败（${e instanceof Error ? e.message : e}）：archive.org 在中国大陆网络常被墙；可待 Tor 出口连通后改用 fetch_tor 访问快照`)
  }
}

/** 取最近一次快照时间戳 */
async function latestSnapshot(url: string): Promise<string | undefined> {
  try {
    const snaps = await cdxSearch(url, undefined, undefined, 5)
    return snaps.length ? snaps[snaps.length - 1]?.timestamp : undefined
  } catch {
    return undefined
  }
}

/** archive.today 快照查询（补充通道，抓取 newest 重定向） */
export async function archiveTodayLookup(url: string): Promise<{ found: boolean; snapshotUrl?: string; content?: string }> {
  try {
    const res = await fetch(`https://archive.ph/newest/${url}`, { redirect: 'manual' })
    if (res.status === 302 || res.status === 301) {
      const loc = res.headers.get('location') ?? ''
      if (loc && !loc.includes('/newest/')) {
        return { found: true, snapshotUrl: loc }
      }
    }
    return { found: false }
  } catch {
    return { found: false }
  }
}
