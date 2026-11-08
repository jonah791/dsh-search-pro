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
import { arxivByIds, arxivIdFromUrl, searchAcademic } from './deep.js'
import { mapApiItems, publishedAtFromExtra } from './intel-api.js'
import type { TimeSource } from './published-at.js'
import { diffNew, fingerprint, isIntelWorthy, normalizeItem, pickBackfill, type IntelItem, type IntelTarget, type ScanOutcome } from './intel.js'
import type { IntelStore } from './intel-store.js'
import { findTemplateBatches, suppressIds } from './intel-poison.js'

export interface ScanOpts {
  maxPages?: number
  maxDepth?: number
  delayMs?: number
  /** 取 XML 的注入点（缺省 httpGet）。定向回填要能**离线测**——真发请求的判据测不了。 */
  fetchXml?: (url: string) => Promise<string>
}

export interface ScanResult extends ScanOutcome {
  /** 本轮新增的条目（已落盘） */
  items: IntelItem[]
  /** 本轮扫到的候选总数（去重前） */
  rawCount: number
  /** 本轮**补写**了 publishedAt 的存量条目数（「给已落盘条目加字段」的通用缺口，见 pickBackfill） */
  backfilled?: number
  /**
   * 本轮因「同模板批量」被拦下、**未入库**的条目数（2026-11-08）。
   *
   * 必须报出来的理由：压制是「这一条我没存」，而「源今天没产垃圾」与
   * 「源还在产、只是全被我拦在门外」在读数上必须能分开——否则下次读的人
   * 会以为源变干净了，而防护一旦失效也没人会发现。
   */
  poisonSuppressed?: number
}

/**
 * 定向回填：按 **arxiv id** 直接问源，补上已落盘条目的 `publishedAt`。
 *
 * 与 `pickBackfill` 的分工（2026-10-17 实测驱动）：
 * - `pickBackfill` 的覆盖面 = **本轮重扫结果 ∩ 库里缺字段条目**。查询变更
 *   （`arxiv-deepweb` 三次重建）或源侧排序漂移会让这个交集**归零** ⇒ 旧条目永远补不上
 *   （实测：23 条全缺，而同 query 未变的另一目标补上了 9 条）。
 * - 本函数按**条目标识**问源 ⇒ 与查询无关。
 *
 * 幂等：缺口为空直接返回 0（**零请求**——补完就不再打源）。
 * 有界：一次最多 `maxIds` 条（`id_list` 过长会被源拒，请求体量也要可控）。
 */
export async function backfillArxivByIds(
  store: IntelStore,
  targetId: string,
  fetcher?: (url: string) => Promise<string>,
  maxIds = 50,
): Promise<number> {
  const known = store.listItems({ targetId, limit: 0 }).items
  const ids: string[] = []
  const seen = new Set<string>()
  for (const it of known) {
    if (it.publishedAt) continue
    const id = arxivIdFromUrl(it.url)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= maxIds) break
  }
  if (ids.length === 0) return 0

  const rs = await arxivByIds(ids, fetcher)
  // id 一律经 fingerprint 归一后再比对（库里 id 就是归一化产物，见 normalizeItem）——
  // 源返回的 <id> 是 `http://arxiv.org/abs/...` 形态，直接拿原始串比对会全部 miss。
  const timeById = new Map<string, string>()
  for (const r of rs) {
    const t = publishedAtFromExtra(r.extra)
    if (t) timeById.set(fingerprint(r.url), t)
  }
  let n = 0
  for (const it of known) {
    if (it.publishedAt) continue
    const t = timeById.get(it.id)
    if (!t) continue
    if (store.patchItem(it.id, { publishedAt: t })) n += 1
  }
  return n
}

interface Collected {
  found: Array<{ url: string; title?: string; source?: string; mime?: string; publishedAt?: string; publishedAtFrom?: TimeSource }>
  confidence?: string
  gaps?: string[]
  error?: string
  /** 源级**故障**（与 gaps 的覆盖缺口分开：CC 504 / crt.sh 502 属此类） */
  sourceErrors?: string[]
  /**
   * 端点在取数处的**原始条目数**（截断/跳过**之前**）——2026-11-03 · t-df1b9eeb。
   *
   * 缺省 = 没有额外口径可用（site/domain/arxiv 的 `found.length` 就是原始数）。
   * api 源配上 `maxItems` 时**必须**带这个：否则「端点给了 300 条、我收下 20 条」
   * 会被报成「只有 20 条」，而那个读数正是下次决定要不要调上界的依据。
   */
  rawCount?: number
}

/**
 * 把 URL 里的 `{days:N}` 相对日期占位符折算成 **UTC** 日期（YYYY-MM-DD）。
 *
 * 存在理由（2026-11-03 · 台账 lh-6890ff86）：情报源的 URL 里写死绝对日期
 * （如 GitHub search 的 `created:%3E2026-10-27`）会随窗口滑出而**静默变成死源**——
 * 扫描仍报 `lastScanState=ok`，只是再也扫不到新条目（读数还在，量的却是过去）。
 * 「每周手改一次」是记性；把折算写进扫描路径才是结构。
 *
 * 口径：
 * - 输出 **UTC** 日期（GitHub / arXiv 的日期过滤都按 UTC 理解）；本地 +8 最坏偏 1 天，可接受。
 * - **无占位符 ⇒ 原样返回**（现有全部源零行为变化）。
 * - **非法写法原样保留**（`{days:abc}`、超 10 年）：让它在 URL 里可见地失败，
 *   不静默折算成某个「差不多」的日期——静默兜底会把配置错误变成数据错误。
 * - 只给 `api` 类用：`site`/`domain` 的 url 是被爬取的地址，`{days:7}` 在那里会被当成
 *   路径段，语义不同 ⇒ 不加折算（无占位符时也不受影响，但语义边界要写明）。
 */
export function resolveRelativeDates(url: string, now: Date = new Date()): string {
  return url.replace(/\{days:(\d+)\}/g, (raw: string, digits: string) => {
    const days = Number(digits)
    if (!Number.isSafeInteger(days) || days > 3650) return raw
    return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
  })
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
    // 页面/附件时间（2026-10-17）：site 类此前一律「时间未知」——根因是 discoverSite
    // 返回的是纯 URL 字符串（时间在源侧就没取），与 api/arxiv 那两个实例**不同型**。
    // 现在 discoverSite 旁挂 `times`（带来源标注），这里透成 `publishedAt`。
    // 抽不到的项**不带该键** ⇒ 渲染层如实显示「时间未知」，不用抓取时刻冒充。
    // 2026-11-03（t-aeb619c7）：`from` 原先在这里被丢掉 ⇒ 来源可信度止于本轮读数。
    // `meta`（页面自己声明）与 `page`（附件继承文章页，代理量）在条目里必须可分辨。
    const timeOf = (u: string): { publishedAt?: string; publishedAtFrom?: TimeSource } => {
      const t = s.times[u]
      return t ? { publishedAt: t.at, publishedAtFrom: t.from } : {}
    }
    const found = [
      ...s.pages.map((u) => ({ url: u, source: 'crawl', ...timeOf(u) })),
      ...s.attachments.map((u) => ({ url: u, source: 'crawl-attachment', ...timeOf(u) })),
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
    // 窗口真源：上次扫描成功时间（扫描失败不写入 ⇒ 下次窗口自动变大、自动补漏）。
    const sinceMs = Date.parse(String(target.lastScanAt))
    const hasWindow = Number.isFinite(sinceMs)
    const rs = await searchAcademic(
      q,
      'arxiv',
      // 首轮请求条数（只是探测成本，**不再是窗口大小**）：有窗口后条数由源侧 totalResults 定
      target.spec.maxPages ?? 15,
      (s, e) => {
        errs.push(`${s}: ${e instanceof Error ? e.message : String(e)}`)
      },
      // 监控要的是**新论文**，不是「该主题的经典论文」（U20 实测 A/B：默认相关性排序
      // 返回 2012/2016/2019 老论文；按提交时间降序后严格 2026→2025→2024）。
      {
        arxivSortByDate: true,
        // **动态时间窗**（2026-10-21 主人两度纠正「以天为单位扫描，而不是数量」「非要硬编码吗」）：
        // 窗口＝**上次扫描到现在**，读 target.lastScanAt（上一轮扫描写入，失败则不更新 ⇒ 自动补漏）。
        // ⇒ 零配置、无数字参数；产出多窗口不胀、产出少窗口不变窄。
        // 首次扫描没有 lastScanAt ⇒ 不加日期过滤，退回「按条数取最新」的旧行为。
        ...(hasWindow ? { arxivSinceMs: sinceMs } : {}),
        // 有窗口 ⇒ 窗口是真源 ⇒ 要「窗口内每一条」，条数交给源侧 totalResults 决定
        // （2026-10-22 主人「先把硬编码改掉」：实测 cs.AI 单日 215 / 276，
        //  任何拍出来的条数上界在量大的那天都会漏）。
        ...(hasWindow ? { arxivExactWindow: true } : {}),
        // 被协议上限截断**必须可见**——否则又是一次静默缩水（§5.10）。
        arxivOnTruncated: (total, cap) => {
          errs.push(`truncated: 源侧窗口内 ${total} 篇 > arxiv 协议上限 ${cap}，本轮仅取前 ${cap} 篇`)
        },
        // **窗口下界回退一个 announce 周期**（2026-10-22 实测：arxiv 索引滞后约 22h，
        // 现在 10-21T16:09Z 而索引最新 10-20T17:59Z，且 10-21 窗口 totalResults=0）。
        // 不回退的后果不是「少抓一次」，是**永久漏**：今天扫 0 条 → lastScanAt 推进到此刻
        // → 那批论文明天傍晚才进索引 → 窗口已走过它们。回退后多抓的部分由 id 去重吸收。
        ...(hasWindow ? { arxivAnnounceOverlap: true } : {}),
      },
    )
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
    const rawUrl = target.spec.url
    if (!rawUrl) return { found: [], error: 'api 目标缺 spec.url' }
    // `{days:N}` 在**请求层**折算，**不写回 targets.json**（那里存的是模板，写回就成了一次性快照）。
    // 折算后的串只进 fetch 与错误上下文；条目的 url 由 urlTemplate/idPath 生成，不受影响。
    const url = resolveRelativeDates(rawUrl)
    const itemsPath = target.spec.itemsPath
    if (!itemsPath) return { found: [], error: 'api 目标缺 spec.itemsPath（声明式路径映射，如 data.catalogs.0.articles）' }
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; alice-intel/1.0)', accept: 'application/json,*/*' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) {
        // ⚠ 限流是**出口级**的，不必然是目标不可用——措辞必须自带处置方向，否则读者只会看到
        // 「目标坏了」。2026-11-03 实测（Upbit 公告源 / Cloudflare 1015）：
        //   ① 同一 header 组合在**同一轮**实验里 429 与 200 混杂（② [429, 200]）；
        //   ② 间隔 4s 的同通道序列 [429, 200, 429]；
        //   ③ 所有请求都必须经共享出口节点才能出网（清空代理 env ⇒ 全部 fetch failed）。
        // ⇒ 该出口 IP 上其他流量的速率会波及本请求。此前这份读数被解读成「TLS 指纹差异」，
        //   导致该 target 被误判 16 天（期间它其实一直在正常产出 58 条）。
        //
        // ⚠ **不同源用不同状态码表达限流**：Cloudflare 用 429，GitHub 用 **403** + 文本
        // "API rate limit exceeded"。只认 429 会漏掉一半（2026-11-03 实测：intel_scan 对
        // GitHub search 报 403，而同一时刻同出口的直连探测是 200、配额还剩 9）。
        // ⇒ 判据不能是状态码，要**读源说的话**。
        //
        // 响应体摘要的作用：GitHub 的 403 body 里带 `for <IP>`，那是判断「出口问题 vs 配额问题」
        // 唯一的一手证据；只报状态码等于把关键证据扔掉。
        // 200 字符：够看 GitHub 的 rate-limit 句和 CF 的 1015 标题，又不至于把整页 HTML 灌进上下文。
        let snippet = ''
        try {
          snippet = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200)
        } catch {
          // 读不到 body 不该让诊断本身变成故障
        }
        const detail = snippet ? `｜源说：${snippet}` : ''
        const looksLimited = res.status === 429 || /rate.?limit|too many requests|1015/i.test(snippet)
        const hint = looksLimited
          ? '｜限流（共享出口上他人流量会波及），不必然是目标不可用：先降触发频率或稍后重试；' +
            '若定时扫描长期正常而仅手动连发失败 ⇒ 即撞窗口，不是目标坏了'
          : ''
        return { found: [], sourceErrors: [`api: HTTP ${res.status} ${res.statusText}${detail}${hint}`] }
      }
      const json: unknown = await res.json()
      const mapped = mapApiItems(json, {
        url,
        itemsPath,
        ...(target.spec.idPath ? { idPath: target.spec.idPath } : {}),
        ...(target.spec.titlePath ? { titlePath: target.spec.titlePath } : {}),
        ...(target.spec.urlTemplate ? { urlTemplate: target.spec.urlTemplate } : {}),
        ...(target.spec.timePath ? { timePath: target.spec.timePath } : {}),
        // ⚠ 这里**逐字段拼** spec，漏一个字段就等于「配了但不生效」——
        // 2026-11-03 加 maxItems 时正是差点漏掉这处（字段、类型、工具参数都加了，
        // 唯独消费点没接 ⇒ 行为完全不变，而任何静态检查都不会报错）。
        ...(target.spec.maxItems !== undefined ? { maxItems: target.spec.maxItems } : {}),
      })
      return {
        found: mapped.items,
        // 结构性失败 ⇒ 源级故障（让读数可见）；跳过计数 ⇒ 覆盖缺口（不误报「源在坏」）
        sourceErrors: mapped.errors.map((e) => `api: ${e}`),
        gaps: mapped.notes.map((e) => `api: ${e}`),
        // 端点原始数（截断前）——与 found.length 不同时，说明 maxItems 起了作用
        rawCount: mapped.rawCount,
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
async function scanTargetCore(target: IntelTarget, store: IntelStore, opts: ScanOpts = {}): Promise<ScanResult> {
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
  // ⚠ **库里已有的 id 一律不再重写**（2026-10-22 实测 bug，第二个「处理被抹掉」的原因）：
  // 快照是**缓存**，items.jsonl 才是**权威**。快照一旦变窄（读失败 / remove+add 重建 /
  // 保存中断），`diffNew` 会把库里已存在的条目重新判成「新」，而 `appendItems` 是
  // **后写胜**（`normalizeItem` 的 status 缺省 'new'）⇒ 用户标过的 seen/starred/dropped
  // 被**静默重置**成 new。实测：快照 rawCount 从 ~250 缩到 49 后，13 条 seen 被打回 new
  // ⇒ 积压永远清不掉（今晚清库的成果会被下一轮扫描抹掉）。
  const persisted = new Set(store.listItems({ targetId: target.id, limit: 0 }).items.map((i) => i.id))
  const items = fresh
    .map((f) =>
      normalizeItem({
        url: f.url,
        targetId: target.id,
        source: f.source,
        title: f.title,
        mime: f.mime,
        ...(f.publishedAt ? { publishedAt: f.publishedAt } : {}),
        ...(f.publishedAt && f.publishedAtFrom ? { publishedAtFrom: f.publishedAtFrom } : {}),
        now,
      }),
    )
    .filter((it) => !persisted.has(it.id))

  // ★ 批量同模板检测（2026-11-08）：刷量仓在**入库前**拦一道。
  //
  // 为什么判据在本地而不在 URL 里：源查询（`stars:>50`）是公开的，刷量方读得到，
  // 于是单条目静态阈值会被反向适配——实测两轮：第一批 fork 46-51 过了 `stars:>50`，
  // 我加 `forks:<40` 后第二批把 fork 刷到 1-10 照样过。唯一站得住的是**关系型**判据：
  // 同一仓库名在 24h 内跨 ≥5 个不同 owner。这个特征单条 API 返回里看不见，只能本地比。
  //
  // 纪律：压制**必须报数**（`poisonSuppressed`），不许静默丢——静默丢会让「源变干净了」
  // 与「源还在灌、只是我看不见」长得一模一样。
  let poisonSuppressed = 0
  if (items.length > 0) {
    const existingNew = store.listItems({ targetId: target.id, limit: 0, status: 'new' }).items
    const batches = findTemplateBatches([...existingNew, ...items])
    const suppressed = suppressIds(batches, items)
    if (suppressed.size > 0) {
      poisonSuppressed = suppressed.size
      const kept = items.filter((it) => !suppressed.has(it.id))
      // 整批全灭也要留痕：把批次摘要写进快照旁的目标字段，下轮 watch 能看到
      store.patchTarget(target.id, {
        lastPoisonBatches: batches.map((b) => ({
          repo: b.repo,
          owners: b.owners.length,
          ids: b.ids.length,
          spanHours: Math.round(b.spanHours * 10) / 10,
        })),
      } as Partial<IntelTarget>)
      if (kept.length > 0) store.appendItems(kept)
    } else {
      store.appendItems(items)
    }
  }

  // 存量回填（2026-10-17）：已落盘但缺 publishedAt 的条目，本轮拿到时间就补写。
  // 必要性：diffNew 按指纹去重 ⇒ 已报过的条目**不会重报**，也就**永远不会**带上新字段
  // ——这是「给持久化条目加字段」这类改动的通用缺口，不是这一次的特例。
  // 只在候选真带了发布时间时才读库（site/domain 源没有 ⇒ 零开销）。
  let backfilled = 0
  if (collected.found.some((f) => f.publishedAt)) {
    const knownItems = store.listItems({ targetId: target.id, limit: 0 }).items
    const toBackfill = pickBackfill(collected.found, knownItems)
    for (const b of toBackfill) {
      // 回填时 `from` **必须同时补写**——只补时间不补来源，会让这批条目在渲染层
      // 被当成「直接信号」，而它们其实和本轮新条目拿到的是同一份证据。
      store.patchItem(b.id, {
        publishedAt: b.publishedAt,
        ...(b.publishedAtFrom ? { publishedAtFrom: b.publishedAtFrom } : {}),
      })
    }
    backfilled = toBackfill.length
  }
  // 快照 = 已知 ∪ **本轮扫到的全部候选**（含被 worthy 过滤掉的）——
  // 只记 worthy 会让被过滤的那些在下一轮「变成新的」（2026-10-16 修正：
  // 快照的语义是「我见过什么」，worthy 的语义是「其中值得报的」，两者必须分开）
  const next = new Set(known)
  // 快照必须**只增不减**：并入库里已有的全部 id（`persisted`）。只靠 `known ∪ 本轮`
  // 会让快照在 known 变空/变窄时**永久缩水**，缩水后下一轮把库里已有条目全部重判为新
  // （雪球）。这一项把「权威库（items.jsonl）」与「缓存快照」重新对齐，是治本项。
  for (const id of persisted) next.add(id)
  for (const f of collected.found) next.add(normalizeItem({ url: f.url, targetId: target.id, now }).id)
  store.saveSnapshot(target.id, [...next], { lastScanAt: now, rawCount: collected.rawCount ?? collected.found.length })
  store.patchTarget(target.id, { lastScanAt: now, foundTotal: next.size })

  const sourceErrors = collected.sourceErrors ?? []

  // ★ 定向回填（2026-10-17）：上面那条 `pickBackfill` 依赖「本轮重扫恰好又返回同一篇」，
  // 查询变更/排序漂移会让交集归零 ⇒ 旧条目**永远**补不上时间。这条按**条目标识**问源。
  // 放在 sourceErrors 之后，是为了让回填失败进同一份故障读数：它是**补写不是取数**，
  // 失败不该把本轮扫描判死，但也不许静默（§5.10）。
  if (target.kind === 'arxiv') {
    try {
      backfilled += await backfillArxivByIds(store, target.id, opts.fetchXml)
    } catch (e) {
      sourceErrors.push(`arxiv 定向回填失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
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
    rawCount: collected.rawCount ?? collected.found.length,
    ...(backfilled > 0 ? { backfilled } : {}),
    ...(poisonSuppressed > 0 ? { poisonSuppressed } : {}),
  }
}

/**
 * 扫一个目标 —— 对外入口。
 *
 * 包一层的原因（2026-10-31）：`scanTargetCore` 有 **4 个 return 点**（3 条 failed + 1 条 ok），
 * 逐点写 `lastScanState` 必然漏一个。这里用**单一落点**写结果态：无论从哪条分支返回，
 * 状态都由同一次 `patchTarget` 落盘。
 *
 * 背景：`saveSnapshot` 与 `patchTarget({lastScanAt})` 在失败判定之前无条件执行 ⇒ **失败也推进
 * `lastScanAt`**（对 429 源这比短退避更保守，但此前未声明）。本函数不改这个行为，只补一个
 * 能区分「扫过」与「扫成功」的字段。
 *
 * 判据（尸体样本见 `tests/intel-scan-state.test.mjs`）：
 * ① 429 失败 ⇒ `intel_watch(list)` 必须显示失败态（而不是只有时间）
 * ② 成功一次 ⇒ 失败标记必须清掉（不能一失败就永久红）
 * ③ 老记录无该字段 ⇒ 读作「未知」，不是 ok
 */
export async function scanTarget(target: IntelTarget, store: IntelStore, opts: ScanOpts = {}): Promise<ScanResult> {
  const result = await scanTargetCore(target, store, opts)
  const patch: Partial<IntelTarget> = { lastScanState: result.state }
  if (result.state === 'failed') {
    // 只留首条 + 截断 200：整串 sourceErrors 可能很长，写进 targets.json 会把台账撑爆
    const detail = (result.error ?? '') || (result.sourceErrors ?? []).join(' | ') || '未知失败'
    patch.lastScanError = detail.slice(0, 200)
  } else {
    // 成功必须清掉旧错误——否则「一失败就永久红」（判据②）
    patch.lastScanError = undefined
  }
  store.patchTarget(target.id, patch)
  return result
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
