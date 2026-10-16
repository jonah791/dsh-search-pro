/**
 * 情报系统 · 纯函数层（无 IO，可离线测）。
 *
 * 存在理由（主人 2026-10-16 22:46 指令）：把「一次性搜索」升级成「持续监控」——
 * 监控源 → 定期扫描 → **只报新的** → 结构化沉淀 → 可推送。
 *
 * 核心判据是**增量**：同一目标连扫两次，第二次必须报 0 条新增。
 * 这条判据可证伪（拿同一个源跑两遍对照），是整套系统成立与否的分水岭。
 *
 * 判据纪律：空与失败必须分型——「没有新增」与「扫描失败」是两件事，
 * 不许都渲染成「0 条」。
 */

import { isAttachment, isMetaFile } from './discover.js'

/** 情报条目 */
export interface IntelItem {
  /** 稳定指纹（URL 归一化后） */
  id: string
  /** 来自哪个监控目标 */
  targetId: string
  url: string
  /** 条目类型：附件与网页分开（深网价值在附件） */
  kind: 'page' | 'attachment' | 'paper' | 'unknown'
  /** 标题（源提供时） */
  title?: string
  /** 发现时间（ISO） */
  foundAt: string
  status: 'new' | 'seen' | 'starred' | 'dropped'
  /** 来源标注（crawl / commoncrawl / crtsh / arxiv …） */
  source?: string
  /** 附加元数据（mime / status / 摘要 …） */
  meta?: Record<string, unknown>
}

/** 监控目标 */
export interface IntelTarget {
  id: string
  /** site=站点级发现；domain=多源 URL 发现；arxiv=论文检索 */
  kind: 'site' | 'domain' | 'arxiv'
  /** 目标规格：site/domain 用 url；arxiv 用 query */
  spec: { url?: string; domain?: string; query?: string; maxPages?: number; maxDepth?: number }
  note?: string
  createdAt: string
  /** 上次扫描时间（ISO） */
  lastScanAt?: string
  /** 累计发现条目数 */
  foundTotal?: number
}

/**
 * URL 归一化指纹：同一资源的不同形态（http/https、带 hash、host 大小写）
 * 归一成同一个 key——否则「同一条」会被反复报成新的（增量判据失效）。
 */
export function fingerprint(url: string): string {
  try {
    const u = new URL(url.trim())
    u.hash = ''
    if (u.protocol === 'http:') u.protocol = 'https:'
    u.hostname = u.hostname.toLowerCase()
    return u.toString()
  } catch {
    return url.trim()
  }
}

/**
 * 增量判据：返回 known 之外的新条目。
 * 同时做**批内去重**（同一批里重复的 URL 只报一次）。
 */
export function diffNew<T extends { url: string }>(found: T[], known: Iterable<string>): T[] {
  const seen = new Set(known)
  const local = new Set<string>()
  const out: T[] = []
  for (const f of found) {
    const fp = fingerprint(f.url)
    if (seen.has(fp) || local.has(fp)) continue
    local.add(fp)
    out.push(f)
  }
  return out
}

/** 条目分类：附件 / 论文 / 网页 / 未知 */
export function classifyItem(url: string, mime?: string, source?: string): IntelItem['kind'] {
  if (source === 'arxiv') return 'paper'
  if (isAttachment(url, mime)) return 'attachment'
  if (/^https?:\/\//i.test(url)) return 'page'
  return 'unknown'
}

/** 该 URL 是否值得进情报库（站点协议文件不是情报） */
export function isIntelWorthy(url: string): boolean {
  return !isMetaFile(url) && /^https?:\/\//i.test(url)
}

export interface NormalizeInput {
  url: string
  targetId: string
  source?: string
  title?: string
  mime?: string
  meta?: Record<string, unknown>
  /** 注入时钟（便于测试确定性；缺省 now） */
  now?: string
  /** 初始状态（缺省 new） */
  status?: IntelItem['status']
}

/** 把发现结果规整成情报条目（指纹即 id，天然幂等） */
export function normalizeItem(raw: NormalizeInput): IntelItem {
  const fp = fingerprint(raw.url)
  return {
    id: fp,
    targetId: raw.targetId,
    url: fp,
    kind: classifyItem(fp, raw.mime, raw.source),
    ...(raw.title ? { title: raw.title } : {}),
    foundAt: raw.now ?? new Date().toISOString(),
    status: raw.status ?? 'new',
    ...(raw.source ? { source: raw.source } : {}),
    ...(raw.mime || raw.meta ? { meta: { ...(raw.mime ? { mime: raw.mime } : {}), ...(raw.meta ?? {}) } } : {}),
  }
}

/** 统计（进结论的读数必须现算） */
export function intelStats(items: IntelItem[], targets: IntelTarget[]) {
  const byStatus: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  const byTarget: Record<string, number> = {}
  for (const it of items) {
    byStatus[it.status] = (byStatus[it.status] ?? 0) + 1
    byKind[it.kind] = (byKind[it.kind] ?? 0) + 1
    byTarget[it.targetId] = (byTarget[it.targetId] ?? 0) + 1
  }
  return {
    targets: targets.length,
    total: items.length,
    byStatus,
    byKind,
    byTarget,
  }
}

/** 一条扫描结果的读数（空与失败分型） */
export interface ScanOutcome {
  targetId: string
  /** ok=扫成功（newCount 可为 0）；failed=扫失败（newCount 无意义） */
  state: 'ok' | 'failed'
  foundCount: number
  newCount: number
  error?: string
  /** 覆盖度/置信度（源提供时透出，不吞） */
  confidence?: string
  gaps?: string[]
  /**
   * 部分源失败（2026-10-16 实测抓出：CC 返回 504 时域名目标仍报 ok，扫到数 98→60 静默缩水）。
   * 与 state **正交**：state=ok 表示「扫到了东西」，partial 表示「有源没答」——
   * 后者必须显形，否则「源坏了」会被读成「源没新的」（§5.10 静默失败）。
   */
  partial?: boolean
  /** 失败的源及原因（与 gaps 分开：gaps 是覆盖缺口，这里是**故障**） */
  sourceErrors?: string[]
  elapsedMs: number
}

/** 汇总一批扫描结果的读数（供 digest 与汇报用） */
export function summarizeScans(outcomes: ScanOutcome[]) {
  const ok = outcomes.filter((o) => o.state === 'ok')
  const failed = outcomes.filter((o) => o.state === 'failed')
  const partial = ok.filter((o) => o.partial)
  const newTotal = ok.reduce((s, o) => s + o.newCount, 0)
  const foundTotal = ok.reduce((s, o) => s + o.foundCount, 0)
  return {
    scanned: outcomes.length,
    okCount: ok.length,
    failedCount: failed.length,
    foundTotal,
    newTotal,
    /** 失败的目标 id（响亮列出，不藏） */
    failedTargets: failed.map((o) => o.targetId),
    failures: failed.map((o) => `${o.targetId}: ${o.error ?? '未知原因'}`),
    /** 部分源失败（第三态：扫到了东西，但有源没答）——与整目标失败分开报 */
    partialCount: partial.length,
    partialTargets: partial.map((o) => o.targetId),
    sourceErrors: partial.flatMap((o) => (o.sourceErrors ?? []).map((e) => `${o.targetId}: ${e}`)),
  }
}
