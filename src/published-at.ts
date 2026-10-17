/**
 * 从页面 / URL 抽发布时间（2026-10-17 · 给 **site 类**情报源补时效维）。
 *
 * 为什么需要它：`intel_watch` 的 `timePath` 只对 `kind=api` 生效，而 `discoverSite`
 * 返回的 `pages` / `attachments` 是**纯 URL 字符串** ⇒ site 类条目一律落「时间未知」，
 * 时效维度对它完全失效（2026-10-17 实测：site 类 6/6 条目无时间）。
 *
 * ⚠ 两条设计纪律（都不是风格问题，是判据问题）：
 *
 * ① **每个时间必须带来源**（`from`），且**一个标签只能表示一种可信度**。URL 里的年份
 *    可能是**目录结构**而不是发布时间（`/2018/tousushufanben.zip` 的 2018 是目录名，
 *    2026-10-17 线上取证实测）⇒ **只认完整日期段（年+月+日）**，仅年份段一律不认
 *    （判据与实测见 `extractDateFromUrl`）。「假时效」比「时间未知」更坏：它让人以为
 *    这条很新/很旧，而实际上我们并不知道。
 *
 * ② **抽不到就不返回**，绝不用「抓取时刻」冒充发布时间。缺省状态下上层渲染
 *    「时间未知」——那是**正确行为**（如实标注「不知道」），不是缺陷。
 *
 * 模式选择（**通用优先，不枚举站点**）：只认**结构化信号**（`meta` / `<time>` 标签）
 * 与 **URL 里的显式日期段**。刻意**不做**「正文里出现的第一串日期」——文章正文里
 * 提到的日期（引用、历史事件、表格数据）与发布时间无关，那是**误报温床**。
 */

/** 时间的来源（读的人据此判断可信度） */
export type TimeSource =
  /** `<meta property="article:published_time">` / `<meta name="pubdate">` 等结构化元数据 */
  | 'meta'
  /** `<time datetime="...">` 标签 */
  | 'time-tag'
  /** URL 路径里的**完整日期段**（`/2026/10/17/`、`/20261017/`）——仅年份段不认（假精度） */
  | 'url'
  /** 继承自所在页面（附件用：附件在文章页里，文章页的发布时间≈附件的发布时间） */
  | 'page'

export interface FoundTime {
  /** ISO 8601（`YYYY-MM-DDTHH:mm:ss.sssZ`；只有日期时补 T00:00:00Z） */
  at: string
  from: TimeSource
}

/**
 * 合理性边界（**两条路径共用**）：早于 1990 或晚于「现在 + 1 天」一律不认。
 *
 * ⚠ 2026-10-17 实测教训：初版把边界**只写在 `Date.parse` 那条路径上**，而纯日期路径
 * （`1970-01-01`）直接 return、绕过了它 ⇒ 由 A126 尸体样本当场抓出。
 * ⇒ 边界必须是**统一出口**，不能只在某条分支上（同型缺陷：校验写在一条路径上，
 * 另一条路径静默绕过）。
 */
function plausible(iso: string): string | undefined {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return undefined
  const year = new Date(t).getUTCFullYear()
  if (year < 1990) return undefined
  if (t > Date.now() + 86_400_000) return undefined
  return iso
}

/** 归一成 ISO；认不出返回 undefined（**不猜**） */
function toIso(raw: string): string | undefined {
  const s = raw.trim()
  if (!s) return undefined
  // 纯日期（YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD）⇒ 补零点，避免时区解析歧义
  const dateOnly = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (dateOnly) {
    const y = Number(dateOnly[1])
    const m = Number(dateOnly[2])
    const d = Number(dateOnly[3])
    // ★ 尸体样本纪律：不存在的日期（2026-02-30）必须被拦——JS 原生 Date 会静默滚到 3-02
    if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
    const dt = new Date(Date.UTC(y, m - 1, d))
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined
    return plausible(dt.toISOString())
  }
  // 中文日期（2026年10月17日）
  const cn = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s)
  if (cn) return toIso(`${cn[1]}-${cn[2]}-${cn[3]}`)
  // 其余交给 Date.parse（ISO 时刻、RFC 2822 等），但要求结果**不是** NaN
  const t = Date.parse(s)
  if (Number.isNaN(t)) return undefined
  return plausible(new Date(t).toISOString())
}

/** 取标签属性（大小写不敏感；只处理双引号/单引号两种最常见形态） */
function attrOf(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i')
  const m = re.exec(tag)
  return m?.[1]
}

/**
 * 从 HTML 抽发布时间。**只认结构化信号**（meta / `<time>`），不做正文日期猜测。
 * 优先级：`article:published_time` → 其它 publish/date 类 meta → `<time datetime>`。
 */
export function extractPublishedAt(html: string): FoundTime | undefined {
  if (!html) return undefined

  // ① 结构化 meta（按可信度排序）
  const metaRe = /<meta\b[^>]*>/gi
  let m: RegExpExecArray | null
  const metas: string[] = []
  while ((m = metaRe.exec(html)) !== null) metas.push(m[0])
  const metaKeys = [
    'article:published_time', // Open Graph / schema.org 惯例，最可信
    'og:published_time',
    'publishdate',
    'pubdate',
    'publisheddate',
    'date',
    'dc.date',
    'dc.date.issued',
  ]
  for (const want of metaKeys) {
    for (const tag of metas) {
      const prop = attrOf(tag, 'property') ?? attrOf(tag, 'name') ?? attrOf(tag, 'itemprop')
      if (!prop || prop.toLowerCase() !== want) continue
      const content = attrOf(tag, 'content')
      if (!content) continue
      const iso = toIso(content)
      if (iso) return { at: iso, from: 'meta' }
    }
  }

  // ② `<time datetime="...">`（HTML5 语义标签）
  const timeRe = /<time\b[^>]*>/gi
  while ((m = timeRe.exec(html)) !== null) {
    const dt = attrOf(m[0], 'datetime')
    if (!dt) continue
    const iso = toIso(dt)
    if (iso) return { at: iso, from: 'time-tag' }
  }

  return undefined
}

/**
 * 从 URL 路径抽日期。**只认完整日期段**（`/2026/10/17/`、`/2026-10-17/`、`/20261017/`）。
 *
 * ⚠ **仅年份段（`/2018/`）一律不认** —— 2026-10-17 线上取证后改判，两条判据：
 *
 * ① **假精度**：`/2018/tousushufanben.zip` 只说明「在 2018 那个目录里」，不知道是哪一天；
 *    补成 `2018-01-01T00:00:00Z` 是把**年级信号伪装成日精度断言**。而消费方（`intel.ts`
 *    的 `ageHours`/`ageLabel`）与排序（`index.ts` 按 `publishedAt ?? foundAt`）都把它
 *    当真实时刻用。
 * ② **错的方向恰好最坏**：目录年份常是**建目录那年**，于是 `/2026/xxx.zip`（可能今天刚
 *    发的文件）被断言成「2026-01-01」＝十个月前 ⇒ 在情报摘要里被**降级排序**，恰好压制
 *    新鲜情报，与情报系统的目的相反。
 *
 * 抽不到就返回 undefined：上层如实显示「时间未知」，排序退回 `foundAt`（「刚发现」）——
 * 那才是诚实的。**也不从文件名里的任意数字猜**（那是误报温床）：年份段是「有信息但精度
 * 不足」故丢弃，任意数字是「根本不是日期信号」故也丢弃，两者都不该进 `publishedAt`。
 */
export function extractDateFromUrl(url: string): FoundTime | undefined {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return undefined
  }
  // 完整日期段：/2026/10/17/ 或 /2026-10-17/ 或 /20261017/
  const full = /\/(\d{4})[-/]?(\d{2})[-/]?(\d{2})(?:\/|$|\.)/.exec(path)
  if (full) {
    const iso = toIso(`${full[1]}-${full[2]}-${full[3]}`)
    if (iso) return { at: iso, from: 'url' }
  }
  return undefined
}

/**
 * 附件的时间：优先自身 URL 里的日期，否则**继承所在页面的时间**。
 *
 * 为什么允许继承：附件是在文章页里被发现的，文章页的发布时间≈该附件的发布时间
 * （实测形态：公告页 `/5d/6d/c26758a286061/page.htm` + 它的 `.docx` 附件）。
 * 继承来的时间来源标为 `page`（不是 `url`）。
 *
 * ⚠ **如实标注边界**（2026-10-17）：`from` 目前**止于 `discoverSite` 的 `times` 字段**
 * —— `intel-scan` 的 `timeOf()` 只把 `at` 透成条目的 `publishedAt`，**不落 `from`**。
 * 所以 `from` 现在的用途是**本轮读数与诊断**（命中率 / 来源分布），不是给最终读者看的
 * 可信度标记。要让读者也看见，得给条目加 `publishedAtFrom` 字段并走完
 * 类型→投影→output schema→渲染 四跳（技能 `persisted-field-extension`）——已登记为
 * 任务（`t-aeb619c7`），不在此处假装已做到。
 */
export function timeForAttachment(
  attachmentUrl: string,
  pageTime: FoundTime | undefined,
): FoundTime | undefined {
  const own = extractDateFromUrl(attachmentUrl)
  if (own) return own
  if (pageTime) return { at: pageTime.at, from: 'page' }
  return undefined
}
