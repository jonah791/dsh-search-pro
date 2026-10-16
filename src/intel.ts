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
  /** 条目类型：attachment/paper/api 是高价值（信息载体），page 是站点结构（低） */
  kind: 'page' | 'attachment' | 'paper' | 'api' | 'unknown'
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
  /** site=站点级发现；domain=多源 URL 发现；arxiv=论文检索；api=声明式 JSON 端点 */
  kind: 'site' | 'domain' | 'arxiv' | 'api'
  /**
   * 目标规格：site/domain 用 url；arxiv 用 query；api 用 url + 路径映射。
   *
   * api 的路径映射是**声明式**的——加一个 JSON 源只需填字段，不写代码
   * （2026-10-17：实测币安公告端点公开可用，而网页形态是 SPA 爬不到）。
   */
  spec: {
    url?: string
    domain?: string
    query?: string
    maxPages?: number
    maxDepth?: number
    /** api：条目数组的点路径（支持数字索引），如 `data.catalogs.0.articles` */
    itemsPath?: string
    /** api：id 字段名（缺省 id） */
    idPath?: string
    /** api：标题字段名（缺省 title） */
    titlePath?: string
    /** api：条目链接模板（`{字段名}` 占位），如 `https://x/{code}` */
    urlTemplate?: string
  }
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

/** 条目分类：附件 / 论文 / api / 网页 / 未知（附件判据最强，优先） */
export function classifyItem(url: string, mime?: string, source?: string): IntelItem['kind'] {
  if (isAttachment(url, mime)) return 'attachment'
  if (source === 'arxiv') return 'paper'
  if (source === 'api') return 'api'
  if (/^https?:\/\//i.test(url)) return 'page'
  return 'unknown'
}

/**
 * 高价值类判据（**单一真源**）：附件（信息载体）/ 论文（新知识）/ api（声明式精选）。
 *
 * 抽出来的理由：这个判断至少被三处用到（状态注入分层 / digest 价值排序 / 基线豁免）。
 * 三处各写一遍 = 三处会漂移——新增一个高价值 kind 时必然漏改其中一处。
 *
 * 参数取 `string` 而非联合类型：调用方（如 digest 的排序）拿到的是宽松类型，
 * 收窄在这里发生一次即可——不让每个调用点都写类型断言。
 */
export function isHighValue(kind: string): boolean {
  return kind === 'attachment' || kind === 'paper' || kind === 'api'
}

/**
 * 条目类型的**显示标签**（单一真源）。
 *
 * 抽出来的理由（2026-10-17 实测事故）：新增 `api` kind 时我改了 digest 的渲染
 * 却漏了 intel_scan 的——结果币安公告在扫描读数里显示成 `[页面]`，
 * **读数失真而没有任何报错**。枚举式判据注定在命名空间扩张时静默失效。
 */
export function kindTag(kind: string): string {
  if (kind === 'attachment') return '[附件]'
  if (kind === 'paper') return '[论文]'
  if (kind === 'api') return '[公告]'
  return '[页面]'
}

/**
 * 结构页判据：**容器而非内容**。
 *
 * 存在理由（2026-10-16 线上实测）：161 条情报里 118 条是页面 URL，
 * 而其中大量是 `list.htm` / 栏目页 / 根路径——这些是**站点结构**不是**情报**。
 * 一个站有几千页，若「新 URL 即情报」，监控就退化成站点地图增量，无限产噪音。
 *
 * 判据形态：路径末尾是容器词（list/index/default/more/search/column/category）
 * 或路径以 `/` 结尾（目录本身）。文章页用具体 ID（如 `/5d/6d/c26758a286061/page.htm`）
 * ⇒ 不命中，保留。
 *
 * ⚠ 取舍方向：宁可漏报（把内容页误判成结构页）也不多报——情报系统的价值在信噪比，
 * 噪音会让人不再看（HALT/S2G 的「宁欠报不早停」同款）。
 */
export function isStructuralPage(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const p = u.pathname
  if (p === '' || p === '/' || p.endsWith('/')) return true
  // `\d*` 是必需的（2026-10-17 线上实测抓出）：`list2.htm` 这类**分页列表页**
  // 只匹配 `list.htm` 会漏判 ⇒ 它进了情报库并被读成内容页（判据比对象宽）
  return /\/(list|index|default|more|search|column|category|tag)\d*\.(htm|html|php|jsp|aspx?|shtml)$/i.test(p)
}

export interface WorthyOpts {
  /**
   * 是否**首次基线扫描**（快照为空）。
   *
   * 基线只收高价值类：站点「本来就有这些页面」不是新闻，报出来等于把
   * 站点地图当情报（2026-10-16 实测：161 条全是同一次基线扫描产的）。
   * 附件与论文例外——它们本身就是信息载体，首次发现即有价值。
   */
  isBaseline?: boolean
  /**
   * 候选的来源通道。
   *
   * `api` 是**声明式精选**（itemsPath 指向的就是「公告列表」这类目标集合），
   * 不是站点地图噪音 ⇒ 不受基线判据限制（2026-10-17）。
   * 若不给 source，api 源首次扫描的条目会被当页面全部丢掉——那是判据比对象严。
   */
  source?: string
}

/**
 * 该 URL 是否值得进情报库。
 *
 * 四层判据：① 非 http(s) / 协议文件 ⇒ 否
 * ② 结构页 ⇒ **永远否**（容器不是内容，与是否基线无关）
 * ③ api 源 ⇒ **是**（声明式精选，不受基线限制）
 * ④ 基线扫描 ⇒ 只有高价值类（attachment / paper）算情报
 */
export function isIntelWorthy(url: string, opts: WorthyOpts = {}): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  if (isMetaFile(url)) return false
  if (isStructuralPage(url)) return false
  if (opts.source === 'api') return true
  if (opts.isBaseline) {
    return isHighValue(classifyItem(url))
  }
  return true
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
