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
import { diffNew, isIntelWorthy, normalizeItem, type IntelItem, type IntelTarget, type ScanOutcome } from './intel.js'
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
}

interface Collected {
  found: Array<{ url: string; title?: string; source?: string; mime?: string }>
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
    const rs = await searchAcademic(q, 'arxiv', target.spec.maxPages ?? 15)
    const found = rs.map((r) => ({ url: r.url, title: r.title, source: 'arxiv' }))
    return { found }
  }
  return { found: [], error: `暂不支持的 target.kind: ${target.kind}（当前支持 site / domain / arxiv）` }
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

  // 过滤掉不该进情报库的（站点协议文件等），再与快照比
  const worthy = collected.found.filter((f) => isIntelWorthy(f.url))
  const known = store.loadSnapshot(target.id)
  const fresh = diffNew(worthy, known)

  const now = new Date().toISOString()
  const items = fresh.map((f) =>
    normalizeItem({
      url: f.url,
      targetId: target.id,
      source: f.source,
      title: f.title,
      mime: f.mime,
      now,
    }),
  )

  if (items.length > 0) store.appendItems(items)
  // 快照 = 已知 ∪ 本轮扫到的（把**全部**worthy 记进去，而不只是新增——
  // 否则那些「已知但本轮又扫到」的会在下轮被当成新的）
  const next = new Set(known)
  for (const f of worthy) next.add(normalizeItem({ url: f.url, targetId: target.id, now }).id)
  store.saveSnapshot(target.id, [...next], { lastScanAt: now, rawCount: worthy.length })
  store.patchTarget(target.id, { lastScanAt: now, foundTotal: next.size })

  const sourceErrors = collected.sourceErrors ?? []
  // 全源失败 ⇒ 如实报 failed（不许因为「没抛异常」就报 ok——那正是 2026-10-16 的静默形状）
  if (worthy.length === 0 && sourceErrors.length > 0) {
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
