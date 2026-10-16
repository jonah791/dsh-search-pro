/**
 * 情报系统 · 声明式 JSON API 源（纯函数层，无 IO）。
 *
 * 存在理由（2026-10-17）：大量高价值情报源是 **JSON API** 而非网页——
 * 实测币安公告端点（`bapi/composite/v1/public/cms/article/list/query`）公开、无反爬、
 * 含「New Cryptocurrency Listing」（上币公告，经典信息差）。而网页形态的公告列表
 * 是 JS 驱动的 SPA，爬取层结构上拿不到。
 *
 * 设计取向：**声明式**——加一个源只需给路径映射（itemsPath / idPath / titlePath /
 * urlTemplate），不写代码。这样「让互联网上的大多数信息都能成为搜索库的一部分」
 * 才是可扩展的，而不是每加一个源都要改插件。
 *
 * 判据纪律（§5.10）：路径取不到 / 字段缺失**不许静默**——
 * 「0 条」与「20 条全被跳过」是两件事，必须分开报。
 */

export interface ApiSpec {
  /** JSON 端点 */
  url: string
  /** 条目数组的点路径（支持数字索引）：如 `data.catalogs.0.articles` */
  itemsPath: string
  /** 唯一 id 的字段名（缺省 `id`） */
  idPath?: string
  /** 标题字段名（缺省 `title`） */
  titlePath?: string
  /** 条目链接模板，如 `https://www.binance.com/en/support/announcement/{code}`
   *  —— `{字段名}` 会被条目上的同名字段替换；缺字段时该条**跳过并计数**（不产残缺 URL） */
  urlTemplate?: string
  /**
   * 发布时间字段名（如币安 `releaseDate` / OKX `pTime`）。
   *
   * 存在理由（2026-10-17 线上实测抓出）：**两个源本来就有这个字段**，而我只记了
   * `foundAt`（我的扫描时刻）⇒ 首扫把 **16–22 天跨度**的条目全报成「新」——
   * 「新发布」与「新发现」被混为一谈，而推送判据里写着「且有时效性」却**无从计算**。
   */
  timePath?: string
}

export interface ApiCandidate {
  url: string
  title?: string
  source?: string
  /** 源侧发布时间（ISO）。**解析不出时不产**（不猜）——编一个时间会让时效性判据建在假数上 */
  publishedAt?: string
}

export interface ApiMapResult {
  items: ApiCandidate[]
  /** 被跳过的条目数（缺 id / 缺模板字段 / 非对象） */
  skipped: number
  /**
   * 数据形状提示（如「跳过 N/20 条」）——**不是故障**。
   *
   * 与 errors 分开的理由：跳过是**数据形状问题**（某条缺字段），源本身是好的；
   * 若混进 errors，上层会把「每轮都跳过 2 条」读成「源一直在坏」⇒ 告警疲劳。
   */
  notes: string[]
  /** 结构性失败（itemsPath 取不到 / 非数组）——源级故障，必须让读数可见 */
  errors: string[]
}

/**
 * 按点路径取值：`'a.b.0.c'`。取不到返回 undefined（不抛——路径是配置，配错要能被读数看见）。
 */
export function pickPath(obj: unknown, path: string): unknown {
  if (!path) return undefined
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(seg)
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined
      cur = cur[idx]
      continue
    }
    if (typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * 渲染 `{字段}` 模板。**任一字段缺失 ⇒ 返回 null**（宁可不产这条，也不产残缺 URL——
 * 残缺 URL 会进快照、污染增量判据，且看起来像「抓到了」）。
 */
export function renderTemplate(tpl: string, item: Record<string, unknown>): string | null {
  let missing = false
  const out = tpl.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = item[k]
    if (v === undefined || v === null || v === '') {
      missing = true
      return ''
    }
    return String(v)
  })
  return missing ? null : out
}

/**
 * 解析源侧发布时间 ⇒ ISO。支持：
 * - 时间戳（数字，或纯数字字符串）：量级判据 —— `≥1e12` 视为**毫秒**，`≥1e9` 视为**秒**
 * - 可被 `Date.parse` 的字符串（ISO / `2026-10-14 03:30:00`）
 *
 * **解析不出返回 undefined（不猜）**：编一个时间会让「时效性」判据建在假数上，
 * 而假数看起来与真数一模一样。调用方必须把这个失败**计数并报出**——
 * 「源没给时间」与「时间是空的」是两件事（§5.10）。
 */
export function parseApiTime(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined
  if (typeof v === 'number') return fromEpoch(v)
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return undefined
    if (/^\d+$/.test(s)) return fromEpoch(Number(s))
    const t = Date.parse(s)
    return Number.isNaN(t) ? undefined : new Date(t).toISOString()
  }
  return undefined
}

/** 纪元值 ⇒ ISO。`< 1e9` 一律不可信（既不是合法秒也不是合法毫秒时间戳） */
function fromEpoch(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined
  const ms = n >= 1e12 ? n : n >= 1e9 ? n * 1000 : NaN
  if (Number.isNaN(ms)) return undefined
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/**
 * 从 academic 源的 `extra` 里取发布时间（arxiv 给 `published: 'YYYY-MM-DD'`，
 * 见 `deep.ts` 的 `academicArxiv`）。
 *
 * 抽成**具名函数**的理由：接线处（intel-scan 的 arxiv 分支）只调它一次，
 * 而这条性质**可离线测**——「字段有却被丢在传输链上」正是 2026-10-17 抓到的形状
 * （36 条论文全「时间未知」，而 `extra.published` 早就在返回值里）。
 */
export function publishedAtFromExtra(extra: unknown): string | undefined {
  if (!extra || typeof extra !== 'object') return undefined
  return parseApiTime((extra as Record<string, unknown>).published)
}

/**
 * 把 JSON 响应映射成候选列表。
 *
 * `source` 固定为 `'api'`——与 crawl / commoncrawl / arxiv 并列，
 * 便于事后分辨「这条是哪条通道拿到的」。
 */
export function mapApiItems(json: unknown, spec: ApiSpec): ApiMapResult {
  const errors: string[] = []
  const arr = pickPath(json, spec.itemsPath)
  if (arr === undefined) {
    return { items: [], skipped: 0, notes: [], errors: [`itemsPath 取不到：${spec.itemsPath}（检查路径与响应形状）`] }
  }
  if (!Array.isArray(arr)) {
    return {
      items: [],
      skipped: 0,
      notes: [],
      errors: [`itemsPath 指向的不是数组：${spec.itemsPath}（实际 ${typeof arr}）`],
    }
  }

  const idKey = spec.idPath ?? 'id'
  const titleKey = spec.titlePath ?? 'title'
  const timeKey = spec.timePath
  const items: ApiCandidate[] = []
  const notes: string[] = []
  let skipped = 0
  let noTime = 0
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped += 1
      continue
    }
    const it = raw as Record<string, unknown>
    let url: string | null = null
    if (spec.urlTemplate) {
      url = renderTemplate(spec.urlTemplate, it)
    } else {
      const idv = it[idKey]
      url = idv === undefined || idv === null || idv === '' ? null : String(idv)
    }
    if (!url) {
      skipped += 1
      continue
    }
    const tv = it[titleKey]
    const publishedAt = timeKey ? parseApiTime(it[timeKey]) : undefined
    if (timeKey && !publishedAt) noTime += 1
    items.push({
      url,
      ...(tv === undefined || tv === null || tv === '' ? {} : { title: String(tv) }),
      ...(publishedAt ? { publishedAt } : {}),
      source: 'api',
    })
  }
  if (skipped > 0) notes.push(`跳过 ${skipped}/${arr.length} 条（缺 id 或模板字段）`)
  // 时间解析失败必须显形：不报的话「源改了时间字段名」会被读成「这批公告没有发布时间」
  if (timeKey && noTime > 0) notes.push(`时间解析失败 ${noTime}/${arr.length} 条（字段 ${timeKey}）`)
  return { items, skipped, notes, errors }
}
