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
  /** 发现时间（ISO）——**我的扫描时刻**，增量判据用它 */
  foundAt: string
  /**
   * 源侧发布时间（ISO）——**源自己的时刻**，时效性判据用它。
   *
   * 与 foundAt **必须分开**（§5.10 语义精确性）：一个 2018 年的老附件今天才被扫到，
   * foundAt 是今天（它确实是**新情报**），publishedAt 是 2018 年（它**没有时效性**）。
   * 两者混用会让「推不推」这个判断失去依据。
   *
   * 缺省 = **源没给**（不是「刚发布」）——渲染时必须显示为「时间未知」。
   */
  publishedAt?: string
  status: 'new' | 'seen' | 'starred' | 'dropped'
  /**
   * 已分诊、待读（与 status **正交**）—— 2026-11-03 新增。
   *
   * 为什么是独立布尔而不是 status 的第五个值：status 表达的是**我的裁决**
   * （读完不特别留 / 读完要留 / 判为无价值），而「分诊过」表达的是**流程位置**，
   * 两者可以同时成立（分诊过了但还没读）。
   *
   * 压进单值会逼我在两个谎言里二选一：伪称 seen（我读过）或伪称 dropped（它没价值）。
   * 前者污染「读过」的读数，后者会真的把它从筛选池里删掉——一个合法动作
   * （把一批论文分诊完，让它们离开「未读」视野）不该需要撒谎才能完成。
   */
  triaged?: boolean
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
    /** api：发布时间字段名（如币安 `releaseDate` / OKX `pTime`）——毫秒/秒时间戳或 ISO 字符串 */
    timePath?: string
  }
  note?: string
  createdAt: string
  /** 上次扫描时间（ISO） */
  lastScanAt?: string
  /**
   * 上次扫描的**结果态**。字段缺失（老记录）= **未知**，不是 ok。
   *
   * 存在理由（2026-10-31）：此前 `intel_watch(list)` 只有 `lastScanAt`，而失败也推进它
   * ⇒ 一个连续 429 的源在唯一的巡检视图里与健康源**逐字相同**（2026-10-17 实测 arxiv-deepweb：
   * 双双 429、`state: failed`，但 list 显示 `上次 11:45`，与健康的 api-okx-listing 无任何区别）。
   * 「有上次时间」与「上次成功」是两件事——缺字段时必须读成未知，不许读成健康。
   */
  lastScanState?: 'ok' | 'failed'
  /** 上次失败原因（截断 200 字符，只留首条）。扫描成功时清掉，否则会「一失败就永久红」。 */
  lastScanError?: string
  /** 累计发现条目数 */
  foundTotal?: number
  /**
   * 该目标的扫描周期（分钟）。缺省 ⇒ 用全局 `config.intelScanMinutes`。
   *
   * 存在理由（2026-10-17 · 信息差实证驱动）：全局单一周期对**快源**太慢、对**慢源**太频。
   * 实测：币安下架公告（EPIC/QUICK）发布当日即 **−25% ~ −29%**，行情几小时内走完大半，
   * 而全局缺省是 **360 分钟（6 小时）** ⇒ 最长 6 小时后才看到，**信号已经走掉了**。
   * 而站点爬取 / arxiv 这类慢源 6 小时足够（更频只会浪费预算并触发限速）。
   */
  scanMinutes?: number
}

/**
 * 按**目标**判「到期该扫」⇒ 返回该扫的目标 id 列表。
 *
 * 存在理由（2026-10-17 · 信息差实证驱动）：此前是**全局单周期**（status.json 的 lastScanAt），
 * 对快源太慢、对慢源太频——币安下架公告（EPIC/QUICK）发布当日即 **−25%~−29%**，
 * 而全局缺省 **360 分钟** ⇒ 最长 6 小时后才看到，**信号已经走掉了**。
 *
 * 抽成**纯函数**（而非 apply 内闭包）是为了可离线测：三种情形各有判据——
 * ① 目标自带 `scanMinutes` ⇒ 用它；② 坏值/缺省 ⇒ 回落全局；③ **从没扫过 ⇒ 立刻到期**
 * （否则新登记的目标要干等一个周期才首扫）。
 */
export function dueTargetIds(targets: IntelTarget[], nowMs: number, globalMinutes: number): string[] {
  return targets
    .filter((t) => {
      const per = typeof t.scanMinutes === 'number' && t.scanMinutes > 0 ? t.scanMinutes : globalMinutes
      const last = t.lastScanAt ? Date.parse(String(t.lastScanAt)) : NaN
      if (!Number.isFinite(last)) return true
      return nowMs - last >= per * 60_000
    })
    .map((t) => t.id)
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
  //
  // ⚠ 扩展名**不再枚举**（2026-10-17 第二次线上实测抓出）：上一版写死
  // `\.(htm|html|php|jsp|aspx?|shtml)$`，于是 sues 站的 `list222.psp` 直接漏判进库。
  // 同一个错我当天已经犯过一次（`kindTag` 的枚举漂移）——**枚举式判据注定在命名空间
  // 扩张时静默失效**。改判据形态：容器词是**信息架构**产物（稳定、可枚举），
  // 扩展名是**技术栈**产物（.psp/.do/.action/.jspx 层出不穷）⇒ 扩展名一律通配。
  //
  // `([\d_-]*)(\.[a-z0-9]{1,6})?$` 锚到**路径末段结尾**：容器词后只允许数字/下划线/连字符
  // 与一个扩展名。⇒ `/index-2026-report` 这类**内容页**（字母紧跟）不命中，安全。
  return /\/(list|index|default|more|search|column|category|tag|nav|menu)([\d_-]*)(\.[a-z0-9]{1,6})?$/i.test(p)
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
    // ⚠ `opts.source` 必须转交（2026-10-18 实测事故 · Bug A）：
    // 丢了它 ⇒ classifyItem 落 URL 兜底返回 'page' ⇒ **arxiv 论文在基线扫描时被当页面丢弃**。
    // 而它已进快照（快照存的是 collected.found 全部）⇒ diffNew 认为「见过」⇒ **永不再报**。
    // 实证：arxiv-deepweb 的 SpiderSapien（2609.02532v1，SORTED 第 1 条）在快照不在库。
    // 这类「参数传递断链」tsc 查不出（形参可选），只能靠尸体样本拦。
    return isHighValue(classifyItem(url, undefined, opts.source))
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
  /** 源侧发布时间（ISO；源没给就不传——缺省**不是**「现在」） */
  publishedAt?: string
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
    ...(raw.publishedAt ? { publishedAt: raw.publishedAt } : {}),
    status: raw.status ?? 'new',
    ...(raw.source ? { source: raw.source } : {}),
    ...(raw.mime || raw.meta ? { meta: { ...(raw.mime ? { mime: raw.mime } : {}), ...(raw.meta ?? {}) } } : {}),
  }
}

/**
 * 条目时效（小时）。`publishedAt` 缺省或解析不出 ⇒ `undefined`。
 *
 * **「时间未知」不是「刚发布」**（2026-10-17）：缺 publishedAt 时若渲染成 0 小时，
 * 陈旧公告会被显示成新闻。`now` 可注入 ⇒ 纯函数可离线测。
 */
export function ageHours(publishedAt: string | undefined, now: number = Date.now()): number | undefined {
  if (!publishedAt) return undefined
  const t = Date.parse(publishedAt)
  if (Number.isNaN(t)) return undefined
  return (now - t) / 3_600_000
}

/**
 * 时效的**显示标签**（渲染层单一真源，避免每处各写一遍分档）。
 * 负值显形为「未来」——源给的时间在将来说明字段选错或时区错，**必须看得见**。
 */
export function ageLabel(publishedAt: string | undefined, now: number = Date.now()): string {
  const h = ageHours(publishedAt, now)
  if (h === undefined) return '时间未知'
  if (h < 0) return `未来 ${Math.abs(h).toFixed(1)}h`
  if (h < 48) return `${h.toFixed(1)}h 前`
  return `${(h / 24).toFixed(1)}d 前`
}

/**
 * 存量回填：**给已落盘的条目补上后加的字段**。
 *
 * 为什么必须有（2026-10-17 实测）：`diffNew` 按 URL 指纹去重 ⇒ 已报过的条目
 * **不会重报**，也就**永远不会**带上新字段。这是「给持久化条目加字段」这类改动的
 * 通用缺口，不是这一次的特例——库里那 40 条 api 条目全是「时间未知」，
 * 不补写就永远补不上。
 *
 * 幂等：已有 publishedAt 的条目**不动**（后写胜语义下，重复补写会污染事件流）。
 * 返回**要补写的清单**（纯函数不落盘；落盘由调用方做）。
 */
export function pickBackfill(
  found: Array<{ url: string; publishedAt?: string }>,
  known: IntelItem[],
): Array<{ id: string; publishedAt: string }> {
  const byId = new Map(known.map((i) => [i.id, i]))
  const out: Array<{ id: string; publishedAt: string }> = []
  const seen = new Set<string>()
  for (const f of found) {
    if (!f.publishedAt) continue
    const id = fingerprint(f.url)
    if (seen.has(id)) continue
    const cur = byId.get(id)
    if (!cur || cur.publishedAt) continue
    seen.add(id)
    out.push({ id, publishedAt: f.publishedAt })
  }
  return out
}

/**
 * 未读条目按「它该怎么被处置」分段（纯函数，无 IO —— 可单测）。
 *
 * 为什么按 source 而不是按 kind：kind 在真实数据里已同质
 * （2026-11-03 01:04 现读：837 条 new 全是 paper、27 条全是 api），按 kind 分等于没分。
 * source 才是「它怎么进来的」，而那决定它该怎么被处置：
 * arxiv 是每日批量自动入库（**抽样即可，它不是债**），api 是定向端点（逐条判）。
 */
export function intelUnreadBreakdown(items: IntelItem[]) {
  let arxiv = 0
  let api = 0
  let otherHigh = 0
  let otherLow = 0
  for (const i of items) {
    if (i.source === 'arxiv') arxiv += 1
    else if (i.source === 'api') api += 1
    else if (isHighValue(i.kind)) otherHigh += 1
    else otherLow += 1
  }
  return { arxiv, api, otherHigh, otherLow, total: items.length }
}

/**
 * 把分段读数渲染成一行注入文案（纯函数）。
 *
 * 每段后面跟的是**动作**，不是形容词。旧版只说「N 条高价值未读」，
 * 于是 864 这个数读起来像一笔还不清的债——而积压读数最坏的后果不是不准，
 * 是让我因为债太大而**干脆不看它**。
 */
export function renderIntelUnreadLine(
  b: ReturnType<typeof intelUnreadBreakdown>,
  lastScan: string,
): string {
  const seg: string[] = []
  if (b.api > 0) seg.push(`定向 ${b.api} 条待判（判据：与手上的事有没有交集）`)
  if (b.otherHigh > 0) seg.push(`其他源 ${b.otherHigh} 条待判`)
  if (b.otherLow > 0) seg.push(`${b.otherLow} 条页面噪音`)
  if (b.arxiv > 0) seg.push(`arxiv ${b.arxiv} 条待筛（每日自动入库，抽样即可，**不是待读债**）`)
  // 入口必须自带「它现在可见吗」（2026-11-03 · t-bd952b09）：
  // 这行**每轮注入**，而 intel_* 挂在 toolface 的 evidence-retrieval 域里，
  // domain 档默认只留常驻集 ⇒ 不写开域方式，这行就是在每轮推荐一个不可执行的动作。
  // 旧形态更糟：lean 档下工具被 deny（根本不存在），模型会**误选成别的工具**并收到
  // 一条无关的 schema 报错——实测 5 次撞在 interrupt_agent 上。
  // domain 档下退化成响亮失败（unknown tool），但「提示指向不可执行」本身没变。
  return `情报库：${seg.join(' · ')} · 上次扫描 ${lastScan}（intel_digest 看内容 / intel_scan 立刻扫｜intel_* 在 evidence-retrieval 域，domain 档需先 toolface 开域）`
}

/** 统计（进结论的读数必须现算） */
export function intelStats(items: IntelItem[], targets: IntelTarget[]) {
  const byStatus: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  const byTarget: Record<string, number> = {}
  let read = 0
  let triaged = 0
  for (const it of items) {
    byStatus[it.status] = (byStatus[it.status] ?? 0) + 1
    byKind[it.kind] = (byKind[it.kind] ?? 0) + 1
    byTarget[it.targetId] = (byTarget[it.targetId] ?? 0) + 1
    // 「读过」不能只数 status==='seen'（2026-11-03 修）。
    //
    // starred（读完决定留着）和 dropped（读完判为无价值）**也是读过的**。
    // 用 seen 当读过的唯一形式，会让「读过 ∧ 想留着」在读数里整个消失——
    // 现读实测：seen 376 / starred 123 / dropped 515 ⇒ 123 条被排除，占读过总数 1/4。
    // 下游 intel-verdict-check 报「读过但库里不是 seen」17 篇，正是这个口径的产物。
    if (it.status !== 'new') read += 1
    if (it.triaged) triaged += 1
  }
  return {
    targets: targets.length,
    total: items.length,
    /** 读过（seen + starred + dropped）——与「未读」互补，不会把分诊未读算进来 */
    read,
    /** 已分诊待读（status 仍可能是 new） */
    triaged,
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
