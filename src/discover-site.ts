/**
 * 站点级发现：给一个站点，列出它的「内容骨架」。
 *
 * 存在理由（2026-10-16 主人定调「难的是发现」）：
 *   今天抓上工程社团的路径是「搜 → 翻列表页 → 撞到公示公告 → 下 docx」——
 *   靠人工遍历。本模块把那条路径变成一次调用。
 *
 * 设计依据（借鉴 trafilatura/focused_crawler 的决策结构）：
 *   ① 先 robots.txt（礼貌规则 + sitemap 线索）② 再猜 sitemap
 *   ③ BFS 有界爬取，导航页优先 ④ 附件单独收集（深网内容常藏在附件里）
 *   ⑤ 上界控制（maxPages/maxDepth）⑥ 礼貌延迟
 */

import { httpGet, sleep } from './util.js'
import {
  extractDiscoveryLinks,
  isAttachment,
  isJunk,
  extOf,
  normalizeDiscovered,
  type DiscoveredUrl,
} from './discover.js'
import { fetchRobots, probeSitemaps, type SitemapProbe } from './discover-fetch.js'
import { probeSearchEndpoint, expandViaSearch } from './discover-search-fetch.js'
import { extractSeedTerms, extractSearchForms } from './discover-search.js'

export interface SiteOpts {
  /** 最多访问多少页（上界，防爆炸） */
  maxPages?: number
  /** 最大爬取深度 */
  maxDepth?: number
  /** 每页之间的礼貌延迟 */
  delayMs?: number
  /** 单页超时 */
  timeoutMs?: number
  /** 是否跟随「下一页」分页链接 */
  followPagination?: boolean
  /** 是否解析 sitemap 里的 URL */
  useSitemap?: boolean
  /** 每个栏目最多入队多少个 URL（防单栏目吃光预算，缺省 3） */
  maxPerColumn?: number
  /** 最多入队多少个不同栏目（缺省 12；防「进入栏目」吃光预算、内容页饿死） */
  maxColumns?: number
  /** 是否探测站内搜索接口并用种子词扩展 URL 前沿（缺省 true；Harnessing the Deep Web 迁移） */
  useSearch?: boolean
  /** 搜索扩展用的种子词上限（缺省 5——论文：URL 数 ∝ 库大小而非查询组合数，**不穷举**） */
  maxSearchTerms?: number
}

export interface SiteDiscovery {
  base: string
  robots: { ok: boolean; sitemaps: string[]; disallow: string[]; error?: string }
  sitemapProbes: SitemapProbe[]
  /** 站内页面 URL */
  pages: string[]
  /** 附件 URL（深网高价值目标） */
  attachments: string[]
  /** feed URL */
  feeds: string[]
  /** 实测读数 */
  stats: {
    fetched: number
    failed: number
    maxDepthReached: number
    byExt: Record<string, number>
  }
  errors: string[]
  /** 覆盖度自评（见 assessCoverage） */
  coverage: SiteCoverage
  /**
   * 站内搜索探测与种子词扩展的读数（Harnessing the Deep Web 迁移）。
   * **三态如实**：found（有结构信号）/ not-found（明确否）/ inconclusive（请求失败或信号不足）
   * ——「没探测到」不许说成「没有搜索接口」。
   */
  search: {
    enabled: boolean
    /** 探测到的搜索接口模板（未探测到为 null） */
    template: string | null
    state: 'found' | 'not-found' | 'inconclusive' | 'skipped'
    reason: string
    /** 实际用的种子词 */
    terms: string[]
    /** 从搜索结果页新发现的同源 URL 数（去重后） */
    expanded: number
    /**
     * 页面里读到的搜索表单（**证据链**：说明「为什么没探测到」——
     * 「有 form 但 method=post」比「inconclusive」有用得多）。
     * 2026-10-16 三站实测：上师大 POST 型 / gov.cn 无 action（JS 驱动）/ wikipedia 需组合参数。
     */
    forms: Array<{ action: string; method: string; inputs: string[]; likely: boolean; basis: string }>
  }
}

/**
 * 覆盖度自评（借鉴 HALT, arXiv:2608.02009：停止判据 = **证据覆盖**而非「觉得够了」；
 * 无法可靠验证覆盖时如实降级，不假装找全了）。
 *
 * 三件事必须分开说：① 找到了什么 ② 还缺什么（分清「没找到」与「找不到」）
 * ③ 这个结论有多可信（多路独立证据 vs 单路 vs 装置不可用）。
 */
export interface SiteCoverage {
  counts: { pages: number; columns: number; attachments: number; feeds: number }
  /** 诚实的缺口清单：每条都说清性质 */
  gaps: string[]
  /** high=多路独立证据一致；medium=单路；low=装置不足或失败率高 */
  confidence: 'high' | 'medium' | 'low'
  /** 为什么是这个置信度（可复核的判据，不写感觉） */
  basis: string[]
}

export interface CoverageInput {
  /** robots.txt 的 error（含 404/410 = 该站未提供；其他 = 取不到） */
  robotsError?: string
  sitemapOkCount: number
  sitemapProbeCount: number
  sitemapNotFoundCount: number
  fetched: number
  failed: number
  maxPages: number
  maxDepth: number
  maxDepthReached: number
  queueRemaining: number
  pages: number
  columns: number
  attachments: number
  feeds: number
}

export function assessCoverage(input: CoverageInput): SiteCoverage {
  const gaps: string[] = []
  const basis: string[] = []
  const total = input.fetched + input.failed
  const failRate = total > 0 ? input.failed / total : 0
  const robotsProvided = !input.robotsError || !/\b(404|410)\b/.test(input.robotsError)

  if (!robotsProvided) {
    gaps.push('robots.txt 未提供（404/410）——该站没这个文件，不是故障')
  } else if (input.robotsError) {
    gaps.push(`robots.txt 存在但取不到（${input.robotsError.slice(0, 80)}）——可能有网关或反爬`)
  }

  if (input.sitemapProbeCount > 0 && input.sitemapOkCount === 0) {
    gaps.push(
      input.sitemapNotFoundCount === input.sitemapProbeCount
        ? `sitemap ${input.sitemapProbeCount} 个候选全部 404/410——该站未提供 sitemap`
        : `sitemap ${input.sitemapProbeCount} 个候选无一可用（部分是故障而非缺失）`,
    )
  } else if (input.sitemapOkCount > 0) {
    basis.push(`sitemap 成功 ${input.sitemapOkCount}/${input.sitemapProbeCount} 个`)
  }

  if (input.attachments === 0) {
    gaps.push(
      input.maxDepthReached >= input.maxDepth && input.queueRemaining === 0
        ? '未发现附件（已触达深度上限且队列耗尽，倾向于该站确实没有可下载附件）'
        : '未发现附件（未穷尽遍历，也可能是附件在更深层或未入队的栏目里）',
    )
  }
  if (input.feeds === 0) gaps.push('未发现 feed（该站可能没有 RSS/Atom）')
  if (input.queueRemaining > 0) {
    gaps.push(`队列仍有 ${input.queueRemaining} 个未访问 URL（预算 ${input.maxPages} 页用尽）——提高 maxPages 可继续`)
  }
  if (input.failed > 0) gaps.push(`有 ${input.failed} 页抓取失败（失败率 ${(failRate * 100).toFixed(0)}%）`)

  let confidence: SiteCoverage['confidence'] = 'medium'
  if (input.fetched === 0) {
    confidence = 'low'
    basis.push('零页抓取成功 ⇒ 装置不可用，不能读成「这个站没有内容」')
  } else if (failRate > 0.3) {
    confidence = 'low'
    basis.push(`失败率 ${(failRate * 100).toFixed(0)}% > 30% ⇒ 覆盖读数不可信`)
  } else if (input.sitemapOkCount > 0 && robotsProvided) {
    confidence = 'high'
    basis.push('robots.txt 与 sitemap 两路独立证据均可用，与爬取结果交叉验证')
  } else if (input.maxDepthReached >= input.maxDepth && input.queueRemaining === 0) {
    confidence = 'high'
    basis.push('爬取触达深度上限且队列耗尽 ⇒ 该边界内已遍历')
  } else {
    basis.push('仅单路证据（爬取），无 sitemap/robots 交叉验证')
  }

  return {
    counts: {
      pages: input.pages,
      columns: input.columns,
      attachments: input.attachments,
      feeds: input.feeds,
    },
    gaps,
    confidence,
    basis,
  }
}

/**
 * 公告/新闻类栏目优先（附件最可能藏在这些栏目里）。
 * ⚠ 2026-10-16 实测：早先的判据含裸 `list` ⇒ 所有栏目页都插队首，
 * 40 页预算被栏目入口吃光，文章页（附件所在）一个都没爬到。
 */
const NAV_HINT = /(gonggao|tzgg|notice|announce|news|xwzx|zhxw|xxgk|tongzhi|dtxx|ggl|hdxx)/i

/**
 * 栏目键：把 list.htm / list1.htm / list2.htm 归一成同一栏目。
 * 存在理由（2026-10-16 实测）：团委站 40 页预算被同一个栏目的分页吃光
 * （list1…list10 全进队首），文章页与附件页永远排不上。
 */
export function columnKey(url: string): string {
  return url.replace(/\/(list|index)\d*\.htm/i, '/$1.htm')
}

/** 内容页判据：上工程站群的文章页形态（/NN/NN/cNNNNN/page.htm） */
export function isContentPage(url: string): boolean {
  return /\/(page|content|article|detail)\.htm/i.test(url) || /\/c\d+a\d+\//i.test(url)
}

function isSameSite(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    if (ua.host === ub.host) return true
    // 同主域不同子域也算（高校站常见 tw./jwc./sme. 多子站）
    const root = (h: string) => h.split('.').slice(-2).join('.')
    return root(ua.host) === root(ub.host)
  } catch {
    return false
  }
}

/** 从 HTML 抽「下一页」候选（中英文 + 常见数字分页模式） */
export function extractPagination(html: string, baseUrl: string): string[] {
  const out: string[] = []
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,40}?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = m[1] ?? ''
    const label = (m[2] ?? '').replace(/<[^>]+>/g, '').trim()
    if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue
    const hit = /下一页|下页|next|more|更多|»/i.test(label) || /^(list|index)\d+\.htm/i.test(href.split('/').pop() ?? '')
    if (!hit) continue
    try {
      out.push(new URL(href, baseUrl).toString())
    } catch {
      /* 非法链接跳过 */
    }
  }
  return [...new Set(out)]
}

/** 从 sitemap 文本里抽 URL（XML 与纯文本两种形态都吃） */
export function parseSitemapText(text: string): string[] {
  const out: string[] = []
  const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi
  let m: RegExpExecArray | null
  while ((m = locRe.exec(text)) !== null) {
    const loc = m[1]
    if (loc) out.push(loc)
  }
  if (out.length === 0) {
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (/^https?:\/\//.test(s)) out.push(s)
    }
  }
  return [...new Set(out)]
}

/**
 * 站点级发现主入口。
 * 返回「站点骨架」：页面 / 附件 / feed / sitemap 探测读数。
 */
export async function discoverSite(baseUrl: string, opts: SiteOpts = {}): Promise<SiteDiscovery> {
  const maxPages = opts.maxPages ?? 30
  const maxDepth = opts.maxDepth ?? 3
  const delayMs = opts.delayMs ?? 300
  const timeoutMs = opts.timeoutMs ?? 20000
  const useSitemap = opts.useSitemap ?? true
  const followPagination = opts.followPagination ?? true
  const maxPerColumn = opts.maxPerColumn ?? 3
  const maxColumns = opts.maxColumns ?? 12

  const base = baseUrl.replace(/\/+$/, '')
  const errors: string[] = []
  const pages = new Set<string>()
  const attachments = new Set<string>()
  const feeds = new Set<string>()
  const byExt: Record<string, number> = {}
  let fetched = 0
  let failed = 0
  let maxDepthReached = 0
  // 站内搜索扩展状态（Harnessing the Deep Web 迁移）：爬到几页后再触发——种子词才有内容
  const useSearch = opts.useSearch !== false
  const maxSearchTerms = opts.maxSearchTerms ?? 5
  let homeHtml = ''
  const searchResult: SiteDiscovery['search'] = {
    enabled: useSearch,
    template: null,
    state: useSearch ? 'not-found' : 'skipped',
    reason: useSearch ? '尚未探测' : 'useSearch=false（调用方关闭）',
    terms: [],
    expanded: 0,
    forms: [],
  }
  let searchDone = !useSearch

  // ① robots.txt
  const robots = await fetchRobots(base)
  if (robots.error) errors.push(`robots: ${robots.error}`)

  // ② sitemap 探测（robots 给的线索优先，再按常见位置猜）
  let sitemapProbes: SitemapProbe[] = []
  let sitemapUrls: string[] = []
  if (useSitemap) {
    const probed = await probeSitemaps(base, robots.sitemaps)
    sitemapProbes = probed.probes
    if (probed.firstText) {
      sitemapUrls = parseSitemapText(probed.firstText)
      for (const u of sitemapUrls) {
        if (isSameSite(u, base)) pages.add(u)
      }
    }
  }

  // ③ BFS 爬取
  const queue: Array<{ url: string; depth: number }> = [{ url: base + '/', depth: 0 }]
  const seen = new Set<string>()
  const perColumn = new Map<string, number>()
  while (queue.length > 0 && fetched < maxPages) {
    const item = queue.shift()
    if (!item) break
    const { url, depth } = item
    const key = url.split('#')[0] ?? url
    if (seen.has(key)) continue
    seen.add(key)
    if (depth > maxDepthReached) maxDepthReached = depth

    let html = ''
    try {
      html = await httpGet(url, { timeoutMs })
      fetched++
    } catch (e) {
      failed++
      errors.push(`${url}: ${e instanceof Error ? e.message : e}`)
      continue
    }
    pages.add(url)
    if (depth === 0 && !homeHtml) homeHtml = html

    // ④ 站内搜索扩展（Harnessing the Deep Web 迁移）：爬满 5 页后做一次，**只做一次**
    if (!searchDone && fetched >= 5) {
      searchDone = true
      try {
        const probeTerm = extractSeedTerms(html, { limit: 1 })[0] ?? 'a'
        // 页面里读到的搜索表单**优先于路径模板**（2026-10-16 实测：盲猜路径两站全撞墙）
        const forms = extractSearchForms(html, url)
        const probe = await probeSearchEndpoint(base, { probeTerm, baselineHtml: homeHtml, forms, timeoutMs })
        searchResult.forms = forms.map((f) => ({
          action: f.action, method: f.method, inputs: f.inputs, likely: f.likely, basis: f.basis,
        }))
        if (probe.hit) {
          const exp = await expandViaSearch(base, html, {
            template: probe.hit.template,
            maxTerms: maxSearchTerms,
            timeoutMs,
          })
          let queued = 0
          for (const u of exp.urls) {
            if (seen.has(u)) continue
            if (!isSameSite(u, base) || isJunk(u) || isAttachment(u)) continue
            queue.push({ url: u, depth: depth + 1 })
            queued++
          }
          searchResult.template = probe.hit.template
          searchResult.state = 'found'
          searchResult.reason = `探测命中：${probe.hit.template}`
          searchResult.terms = exp.terms
          searchResult.expanded = queued
          for (const e of exp.errors) errors.push(`search: ${e}`)
        } else {
          const last = probe.probes[probe.probes.length - 1]
          searchResult.state = probe.probes.some((p) => p.state === 'inconclusive') ? 'inconclusive' : 'not-found'
          // ★ 把「为什么没探测到」说清楚（2026-10-16 三站实测驱动）：
          //   上师大 = POST 型（论文边界内做不到）/ gov.cn = 无 action（JS 驱动）/ 其余 = 没读到表单
          const postOnly = forms.length > 0 && forms.every((f) => f.method === 'post')
          const likelyButNoGet = forms.some((f) => f.likely) && !forms.some((f) => f.likely && f.method === 'get')
          const hint = postOnly
            ? '（页面有搜索表单但是 **POST 型**——论文的结构性边界：只有 GET 可索引）'
            : likelyButNoGet
              ? '（页面有像搜索的表单，但没有可 GET 的文本输入框）'
              : forms.length > 0
                ? `（页面读到 ${forms.length} 个表单，但都不像搜索框）`
                : '（页面里没读到任何含文本输入框的表单）'
          searchResult.reason = (last ? last.reason : '无探测结果') + hint
        }
      } catch (e) {
        searchResult.state = 'inconclusive'
        searchResult.reason = `探测异常：${e instanceof Error ? e.message : String(e)}`
        errors.push(`search: ${searchResult.reason}`)
      }
    }

    const found = extractDiscoveryLinks(html, url)
    for (const s of found.sitemaps) sitemapUrls.push(s)
    for (const f of found.feeds) feeds.add(f)
    for (const a of found.attachments) attachments.add(a)

    // 站内链接入队（导航页优先，插到队首）
    const hrefRe = /href\s*=\s*["']([^"']+)["']/gi
    const nav: Array<{ url: string; depth: number }> = []
    const normal: Array<{ url: string; depth: number }> = []
    let hm: RegExpExecArray | null
    while ((hm = hrefRe.exec(html)) !== null) {
      const raw = hm[1]
      if (!raw || raw.startsWith('javascript:') || raw.startsWith('#') || raw.startsWith('mailto:')) continue
      let abs: string
      try {
        abs = new URL(raw, url).toString()
      } catch {
        continue
      }
      if (!isSameSite(abs, base)) continue
      if (isJunk(abs) || isAttachment(abs)) continue
      if (seen.has(abs)) continue
      if (depth >= maxDepth) continue
      const next = { url: abs, depth: depth + 1 }
      // 内容页优先于深层栏目分页——附件藏在文章页里（实测：栏目分页会吃光预算）
      if (isContentPage(abs)) {
        normal.unshift(next)
        continue
      }
      const ck = columnKey(abs)
      // 新栏目受总数上限约束：否则 40 页预算会被「进入栏目」吃光，内容页饿死
      if (!perColumn.has(ck) && perColumn.size >= maxColumns) continue
      const used = perColumn.get(ck) ?? 0
      if (used >= maxPerColumn) continue
      perColumn.set(ck, used + 1)
      if (NAV_HINT.test(abs)) nav.push(next)
      else normal.push(next)
    }
    // 分页跟随：排到普通队列前部，**不插队首**（否则同一栏目刷屏、内容页饿死）
    if (followPagination && depth < maxDepth) {
      for (const p of extractPagination(html, url)) {
        if (!isSameSite(p, base) || seen.has(p)) continue
        const ck = columnKey(p)
        if (!perColumn.has(ck) && perColumn.size >= maxColumns) continue
        const used = perColumn.get(ck) ?? 0
        if (used >= maxPerColumn) continue
        perColumn.set(ck, used + 1)
        normal.unshift({ url: p, depth: depth + 1 })
      }
    }
    queue.unshift(...nav)
    queue.push(...normal)

    await sleep(delayMs)
  }

  for (const a of attachments) {
    const e = extOf(a)
    if (e) byExt[e] = (byExt[e] ?? 0) + 1
  }

  // 覆盖度自评：把「找到什么 / 缺什么 / 多可信」三件事分开算（HALT 迁移）
  const coverage = assessCoverage({
    robotsError: robots.error,
    sitemapOkCount: sitemapProbes.filter((p) => p.ok).length,
    sitemapProbeCount: sitemapProbes.length,
    sitemapNotFoundCount: sitemapProbes.filter((p) => /\b(404|410)\b/.test(p.error ?? '')).length,
    fetched,
    failed,
    maxPages,
    maxDepth,
    maxDepthReached,
    queueRemaining: queue.length,
    pages: pages.size,
    columns: perColumn.size,
    attachments: attachments.size,
    feeds: feeds.size,
  })

  return {
    base,
    robots: { ok: !robots.error, sitemaps: robots.sitemaps, disallow: robots.disallow, error: robots.error },
    sitemapProbes,
    pages: [...pages],
    attachments: [...attachments],
    feeds: [...feeds],
    stats: { fetched, failed, maxDepthReached, byExt },
    errors,
    coverage,
    search: searchResult,
  }
}

/** 把站点发现结果折成统一的可发现项（便于与多源 URL 发现合流） */
export function siteToDiscovered(site: SiteDiscovery): DiscoveredUrl[] {
  const items: DiscoveredUrl[] = []
  for (const u of site.pages) items.push({ url: u, source: 'crawl' })
  for (const u of site.attachments) items.push({ url: u, source: 'crawl-attachment' })
  for (const u of site.feeds) items.push({ url: u, source: 'crawl-feed' })
  return normalizeDiscovered(items)
}
