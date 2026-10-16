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
}

export interface ApiCandidate {
  url: string
  title?: string
  source?: string
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
  const items: ApiCandidate[] = []
  const notes: string[] = []
  let skipped = 0
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
    items.push({
      url,
      ...(tv === undefined || tv === null || tv === '' ? {} : { title: String(tv) }),
      source: 'api',
    })
  }
  if (skipped > 0) notes.push(`跳过 ${skipped}/${arr.length} 条（缺 id 或模板字段）`)
  return { items, skipped, notes, errors }
}
