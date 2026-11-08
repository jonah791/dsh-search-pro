/**
 * 情报系统 · 批量同模板（刷量仓 / 星农场）检测。**纯函数层**，不碰 IO。
 *
 * ## 存在理由（2026-11-08 两轮实测）
 *
 * `api-github-new-repos` 源的查询是公开的（`created:>7天 topic:llm stars:>50`）。
 * 刷量方直接读得到，于是任何**单条目静态阈值**都会被反向适配：
 *
 * | 轮次 | 特征 | 绕过了什么 |
 * |---|---|---|
 * | 第一批（11-06 18:16） | star 54-55 / fork 46-51 / size 59-111 | `stars:>50` |
 * | 第二批（11-08 新见） | star 53-54 / fork **1-10** / size 88、213-230 | `forks:<40` |
 *
 * ⇒ 判据必须换成**关系型**：同一仓库名在短时间内跨多个不同 owner 出现。
 * 这个特征单条 API 返回里看不见，只能拉回本地跨条目比 —— 所以它属于本层。
 *
 * ## 边界（诚实标注，别当全能）
 *
 * - **按仓库名分组 ⇒ 抓不到「换名字的同批」**。实测漏了 `tireddwarf99/manus-ai`
 *   （同一批刷量把 `ai-manus` 写成 `manus-ai`，按名只出现 1 次）。
 *   要抓它得按 description 分组，而 items.jsonl 目前不存 description ⇒ 需改入库结构。
 * - **时间读不到就不判**（`spanHours = null` 时整批跳过）：读不到 ≠ 没发生，
 *   宁可漏报也不拿「没有时间」当作「时间集中」的证据。
 * - 只判**形状**不判真伪：命中说明「这批值得人看一眼」，不证明一定刷量。
 *   5 个人同期建同名仓库也可能是真实 fork 潮 —— 所以调用方应当**报数**而不是无声丢弃。
 */

import type { IntelItem } from './intel.js'

export interface PoisonOptions {
  /** 组内不同 owner 数达到多少才算一批（缺省 5） */
  minOwners?: number
  /** 这批条目的时间跨度上界（小时，缺省 24） */
  windowHours?: number
}

export interface PoisonBatch {
  targetId: string
  /** 归一后的仓库名（小写、连字符合并） */
  repo: string
  /** 组内出现过的不同 owner（小写去重） */
  owners: string[]
  /** 命中条目的 id（供调用方决定压制哪些） */
  ids: string[]
  /** 这批的时间跨度（小时）；拿不到时间时该批根本不会返回 */
  spanHours: number
}

const DEFAULT_MIN_OWNERS = 5
const DEFAULT_WINDOW_HOURS = 24

/** 仓库名归一：`ai--manus` / `ai_manus` / `AI-Manus` 视为同一个 */
function normalizeRepo(repo: string): string {
  return repo.toLowerCase().replace(/[-_]+/g, '-')
}

/** `owner/repo` 优先取 title，退化到 url 尾部两段 */
function splitOwnerRepo(item: IntelItem): { owner: string; repo: string } | null {
  const title = (item.title ?? '').trim()
  const m = title.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] }
  const url = (item.url ?? '').replace(/\/+$/, '')
  if (!url) return null
  const parts = url.split('/')
  if (parts.length < 2) return null
  const repo = parts[parts.length - 1]
  const owner = parts[parts.length - 2]
  if (!repo || !owner) return null
  return { owner, repo }
}

/** 条目时间：优先 publishedAt（源侧），退化 foundAt（我们发现的时刻） */
function timeOf(item: IntelItem): number | null {
  const raw = item.publishedAt ?? item.foundAt
  if (!raw) return null
  const v = Date.parse(raw)
  return Number.isFinite(v) ? v : null
}

/**
 * 找「同模板批量」的仓库批。
 *
 * 只考察 `status === 'new'`（或未标状态）的条目 —— 已处置的不重复报，
 * 否则每次扫描都会把历史批次再报一遍。
 */
export function findTemplateBatches(items: readonly IntelItem[], opts: PoisonOptions = {}): PoisonBatch[] {
  const minOwners = opts.minOwners ?? DEFAULT_MIN_OWNERS
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS

  const groups = new Map<string, { item: IntelItem; owner: string; repo: string }[]>()
  for (const item of items) {
    const status: string | undefined = item.status
    if (status && status !== 'new') continue
    const sp = splitOwnerRepo(item)
    if (!sp) continue
    const key = `${item.targetId ?? ''}::${normalizeRepo(sp.repo)}`
    const bucket = groups.get(key)
    const entry = { item, owner: sp.owner.toLowerCase(), repo: normalizeRepo(sp.repo) }
    if (bucket) bucket.push(entry)
    else groups.set(key, [entry])
  }

  const out: PoisonBatch[] = []
  for (const [key, bucket] of groups) {
    const owners = [...new Set(bucket.map((b) => b.owner))]
    if (owners.length < minOwners) continue
    const times = bucket.map((b) => timeOf(b.item)).filter((t): t is number => t !== null)
    // 拿不到时间 ⇒ 不判（读不到 ≠ 没发生）。至少要有两个时刻才谈得上「跨度」。
    if (times.length < 2) continue
    const spanHours = (Math.max(...times) - Math.min(...times)) / 3_600_000
    if (spanHours > windowHours) continue
    out.push({
      targetId: key.split('::')[0] ?? '',
      repo: bucket[0]?.repo ?? '',
      owners,
      ids: bucket.map((b) => b.item.id),
      spanHours,
    })
  }
  // 命中条数多的排前面（读数优先看大的）
  out.sort((a, b) => b.ids.length - a.ids.length)
  return out
}

/**
 * 从一批条目里挑出**应当压制的**那些。
 *
 * 只压「本批新增的」——历史条目已经进库，压制它们等于改写过去（那是另一件事，
 * 要用 `intel_prune` 显式做）。
 */
export function suppressIds(batches: readonly PoisonBatch[], candidates: readonly IntelItem[]): Set<string> {
  const hit = new Set<string>()
  const candidateIds = new Set(candidates.map((c) => c.id))
  for (const b of batches) {
    for (const id of b.ids) {
      if (candidateIds.has(id)) hit.add(id)
    }
  }
  return hit
}
