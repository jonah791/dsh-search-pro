/**
 * 情报系统 · 扫描编排层。
 *
 * 把今晚建成的「发现能力」接到「情报」上：每个 target 按 kind 分派到对应取数器，
 * 扫描结果与快照比对得出增量，落盘后**立即更新快照**（否则下一轮会重复报同一批）。
 *
 * 失败分型（§5.10）：单个 target 失败不拖垮整批，但必须响亮列出——
 * 「0 条新增」与「扫描失败」是两件事，不许都渲染成 0。
 */

import { discoverSite } from './discover-site.js'
import { discoverUrls } from './discover-fetch.js'
import { searchAcademic } from './deep.js'
import { mapApiItems, publishedAtFromExtra } from './intel-api.js'
import { diffNew, isIntelWorthy, normalizeItem, pickBackfill, type IntelItem, type IntelTarget, type ScanOutcome } from './intel.js'
import type { IntelStore } from './intel-store.js'

export interface ScanOpts {
  maxPages?: number
  maxDepth?: number
  delayMs?: number
}

export interface ScanResult extends ScanOutcome {
  /** 本轮新增的条目（已落盘） */
  items: IntelItem[]
  /** 本轮扫到的候选总数（去重前） */
  rawCount: number
  /** 本轮**补写**了 publishedAt 的存量条目数（「给已落盘条目加字段」的通用缺口，见 pickBackfill） */
  backfilled?: number
}

interface Collected {
  found: Array<{ url: string; title?: string; source?: string; mime?: string; publishedAt?: string }>
  confidence?: string
  gaps?: string[]
  error?: string
  /** 源级**故障**（与 gaps 的覆盖缺口分开：CC 504 / crt.sh 502 属此类） */
  sourceErrors?: string[]
}

/** 取数：把 target 变成一组候选 */
async function collect(target: IntelTarget, opts: ScanOpts): Promise<Collected> {
  if (target.kind === 'site') {
    const url = target.spec.url
    if (!url) return { found: [], error: 'site 目标缺 spec.url' }
    const s = await discoverSite(url, {
      maxPages: target.spec.maxPages ?? opts.maxPages ?? 30,
      maxDepth: target.spec.maxDepth ?? opts.maxDepth ?? 3,
      delayMs: opts.delayMs ?? 150,
    })
    const found = [
      ...s.pages.map((u) => ({ url: u, source: 'crawl' })),
      ...s.attachments.map((u) => ({ url: u, source: 'crawl-attachment' })),
    ]
    return { found, confidence: s.coverage.confidence, gaps: s.coverage.gaps }
  }
  if (target.kind === 'domain') {
    const d = target.spec.domain ?? target.spec.url
    if (!d) return { found: [], error: 'domain 目标缺 spec.domain' }
    const r = await discoverUrls(d, { limit: 50 })
    const found = r.urls.map((u) => ({ url: u.url, source: u.source, mime: u.mime }))
    // 源错误是**故障**不是覆盖缺口（2026-10-16 实测：CC 504 时曾静默缩水 98→60 却仍报 ok）
    const sourceErrors = Object.entries(r.errors).map(([k, v]) => `${k}: ${String(v).slice(0, 160)}`)
    return { found, sourceErrors }
  }
  if (target.kind === 'arxiv') {
    const q = target.spec.query
    if (!q) return { found: [], error: 'arxiv 目标缺 spec.query' }
    // 源错误必须带出来（2026-10-17 实测：arxiv 失败曾被上层吞成「扫到 0 条 · state=ok」）
    const errs: string[] = []
    const rs = await searchAcademic(q, 'arxiv', target.spec.maxPages ?? 15, (s, e) => {
      errs.push(`${s}: ${e instanceof Error ? e.message : String(e)}`)
    })
    const found = rs.map((r) => {
      // 论文的发布时间决定它是不是**新论文**（2026-10-17：36 条论文全「时间未知」，
      // 而字段**早就在手里**——deep.ts 已取 `extra.published`，只是这里没接上。
      // 与 api 源的 timePath 是同一类缺陷的第二个实例：**字段有，传输链上丢了**。）
      const publishedAt = publishedAtFromExtra((r as unknown as { extra?: unknown }).extra)
      return { url: r.url, title: r.title, source: 'arxiv', ...(publishedAt ? { publishedAt } : {}) }
    })
    return { found, sourceErrors: errs }
  }
  if (target.kind === 'api') {
    const url = target.spec.url
    if (!url) return { found: [], error: 'api 目标缺 spec.url' }
    const itemsPath = target.spec.itemsPath
    if (!itemsPath) return { found: [], error: 'api 目标缺 spec.itemsPath（声明式路径映射，如 data.catalogs.0.articles）' }
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; alice-intel/1.0)', accept: 'application/json,*/*' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) return { found: [], sourceErrors: [`api: HTTP ${res.status} ${res.statusText}`] }
      const json: unknown = await res.json()
      const mapped = mapApiItems(json, {
        url,
        itemsPath,
        ...(target.spec.idPath ? { idPath: target.spec.idPath } : {}),
        ...(target.spec.titlePath ? { titlePath: target.spec.titlePath } : {}),
        ...(target.spec.urlTemplate ? { urlTemplate: target.spec.urlTemplate } : {}),
        ...(target.spec.timePath ? { timePath: target.spec.timePath } : {}),
      })
      return {
        found: mapped.items,
        // 结构性失败 ⇒ 源级故障（让读数可见）；跳过计数 ⇒ 覆盖缺口（不误报「源在坏」）
        sourceErrors: mapped.errors.map((e) => `api: ${e}`),
        gaps: mapped.notes.map((e) => `api: ${e}`),
      }
    } catch (e) {
      return { found: [], sourceErrors: [`api: ${e instanceof Error ? e.message : String(e)}`] }
    }
  }
  return { found: [], error: `暂不支持的 target.kind: ${target.kind}（当前支持 site / domain / arxiv / api）` }
}

/**
 * 扫一个目标并落盘增量。**快照更新与落盘在同一函数内**，
 * 保证「报过了就不会再报」这条判据不会因为调用方忘记而失效。
 */
export async function scanTarget(target: IntelTarget, store: IntelStore, opts: ScanOpts = {}): Promise<ScanResult> {
  const t0 = Date.now()
  let collected: Collected
  try {
    collected = await collect(target, opts)
  } catch (e) {
    return {
      targetId: target.id,
      state: 'failed',
      foundCount: 0,
      newCount: 0,
      error: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - t0,
      items: [],
      rawCount: 0,
    }
  }
  if (collected.error) {
    return {
      targetId: target.id,
      state: 'failed',
      foundCount: 0,
      newCount: 0,
      error: collected.error,
      elapsedMs: Date.now() - t0,
      items: [],
      rawCount: 0,
    }
  }

  // 先看快照是否为空——决定这次是不是**首次基线扫描**（基线只收高价值类）
  const known = store.loadSnapshot(target.id)
  const isBaseline = known.size === 0
  // 过滤掉不该进情报库的（协议文件 / 结构页 / 基线期的普通页面），再与快照比。
  // source 必须传下去：api 源是声明式精选，不受基线判据限制（否则首次扫描的公告全被丢）
  const worthy = collected.found.filter((f) =>
    isIntelWorthy(f.url, { isBaseline, ...(f.source ? { source: f.source } : {}) }),
  )
  const fresh = diffNew(worthy, known)

  const now = new Date().toISOString()
  const items = fresh.map((f) =>
    normalizeItem({
      url: f.url,
      targetId: target.id,
      source: f.source,
      title: f.title,
      mime: f.mime,
      ...(f.publishedAt ? { publishedAt: f.publishedAt } : {}),
      now,
    }),
  )

  if (items.length > 0) store.appendItems(items)

  // 存量回填（2026-10-17）：已落盘但缺 publishedAt 的条目，本轮拿到时间就补写。
  // 必要性：diffNew 按指纹去重 ⇒ 已报过的条目**不会重报**，也就**永远不会**带上新字段
  // ——这是「给持久化条目加字段」这类改动的通用缺口，不是这一次的特例。
  // 只在候选真带了发布时间时才读库（site/domain 源没有 ⇒ 零开销）。
  let backfilled = 0
  if (collected.found.some((f) => f.publishedAt)) {
    const knownItems = store.listItems({ targetId: target.id, limit: 0 }).items
    const toBackfill = pickBackfill(collected.found, knownItems)
    for (const b of toBackfill) store.patchItem(b.id, { publishedAt: b.publishedAt })
    backfilled = toBackfill.length
  }
  // 快照 = 已知 ∪ **本轮扫到的全部候选**（含被 worthy 过滤掉的）——
  // 只记 worthy 会让被过滤的那些在下一轮「变成新的」（2026-10-16 修正：
  // 快照的语义是「我见过什么」，worthy 的语义是「其中值得报的」，两者必须分开）
  const next = new Set(known)
  for (const f of collected.found) next.add(normalizeItem({ url: f.url, targetId: target.id, now }).id)
  store.saveSnapshot(target.id, [...next], { lastScanAt: now, rawCount: collected.found.length })
  store.patchTarget(target.id, { lastScanAt: now, foundTotal: next.size })

  const sourceErrors = collected.sourceErrors ?? []
  // 全源失败 ⇒ 如实报 failed（不许因为「没抛异常」就报 ok——那正是 2026-10-16 的静默形状）
  // 判据用**候选数**而非 worthy 数：worthy 被过滤光但候选非空 = 扫描成功只是没有值得报的
  if (collected.found.length === 0 && sourceErrors.length > 0) {
    return {
      targetId: target.id,
      state: 'failed',
      foundCount: 0,
      newCount: 0,
      error: `全部源失败：${sourceErrors.join(' | ')}`,
      sourceErrors,
      elapsedMs: Date.now() - t0,
      items: [],
      rawCount: 0,
    }
  }

  return {
    targetId: target.id,
    state: 'ok',
    foundCount: worthy.length,
    newCount: items.length,
    confidence: collected.confidence,
    gaps: collected.gaps,
    partial: sourceErrors.length > 0,
    sourceErrors: sourceErrors.length > 0 ? sourceErrors : undefined,
    elapsedMs: Date.now() - t0,
    items,
    rawCount: collected.found.length,
    ...(backfilled > 0 ? { backfilled } : {}),
  }
}

/** 扫全部目标（串行，礼貌；单个失败不影响其他） */
export async function scanAll(store: IntelStore, opts: ScanOpts & { targetIds?: string[] } = {}): Promise<ScanResult[]> {
  const all = store.listTargets()
  const targets = opts.targetIds && opts.targetIds.length ? all.filter((t) => opts.targetIds?.includes(t.id)) : all
  const out: ScanResult[] = []
  for (const t of targets) {
    out.push(await scanTarget(t, store, opts))
  }
  return out
}
