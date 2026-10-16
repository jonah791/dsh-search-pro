/**
 * 站内搜索探测的 IO 层（2026-10-16 · Harnessing the Deep Web 迁移）。
 *
 * 职责边界：
 *   · 只做「探测 GET 搜索接口 + 用种子词迭代查询 + 从结果页提取同源链接」
 *   · **不做过滤决策**（是否入队、是否算附件，交给 discover-site 的既有判据——单一真源）
 *   · **不做 POST、不填表单**（论文的结构性边界：只有 GET 可索引）
 *
 * 预算纪律（论文：**生成 URL 数 ∝ 库大小，而非查询组合数**）：
 *   · 探测模板上限（默认 6 个）· 种子词上限（默认 5 个）
 *   · **不穷举查询词**——只取信息量最高的几个
 */

import { httpGet, sleep } from './util.js'
import {
  SEARCH_PATH_TEMPLATES, buildSearchUrl, looksLikeSearchResults, extractSeedTerms,
  extractSearchForms, formToProbeUrl,
  type SearchProbe, type SearchProbeState, type SearchForm,
} from './discover-search.js'

export interface SearchProbeOpts {
  /** 探测词——用**站点自己的词**（从首页标题取）比用 "test" 更可能命中 */
  probeTerm: string
  /** 首页 HTML（作基线：与首页几乎相同 ⇒ 查询词未生效） */
  baselineHtml?: string
  /** ★ 页面里读到的搜索表单（**优先于路径模板**——2026-10-16 实测：盲猜路径两站全撞墙） */
  forms?: SearchForm[]
  timeoutMs?: number
  maxTemplates?: number
  delayMs?: number
}

export interface ProbeOutcome {
  probes: SearchProbe[]
  /** 命中时带上结果页（供调用方复用，避免重复请求） */
  hit?: { template: string; url: string; html: string }
  errors: string[]
}

/**
 * 探测站点是否有可用的 GET 搜索接口。**命中即停**（省请求）。
 *
 * 顺序（2026-10-16 实测驱动）：**① 页面里读到的表单**（已知事实，不猜）→ **② 常见路径模板**（兜底）。
 * 实测教训：两个站盲猜路径全撞墙（上师大 **410**「已废弃」/ gov.cn **403**「禁止」）——
 * 而页面自己的 `<form>` 是**已知事实**，不是猜测。
 *
 * ⚠ 三态如实：`found`（有结构信号）/ `not-found`（明确否）/ `inconclusive`（请求失败或信号不足）
 *   —— 调用方**必须把三态透出**，不得把「没探测到」说成「没有搜索接口」。
 */
export async function probeSearchEndpoint(base: string, opts: SearchProbeOpts): Promise<ProbeOutcome> {
  const timeoutMs = opts.timeoutMs ?? 20000
  const maxTemplates = opts.maxTemplates ?? 6
  const delayMs = opts.delayMs ?? 200
  const probes: SearchProbe[] = []
  const errors: string[] = []

  // ① 表单候选（页面里读到的，不猜）
  const candidates: Array<{ template: string; url: string }> = []
  for (const f of opts.forms ?? []) {
    if (!f.likely) continue
    const u = formToProbeUrl(f, opts.probeTerm)
    if (u) candidates.push({ template: `form[${f.inputs[0]}]`, url: u })
  }
  const formCount = candidates.length
  // ② 路径模板兜底
  for (const t of SEARCH_PATH_TEMPLATES.slice(0, maxTemplates)) {
    candidates.push({ template: t, url: buildSearchUrl(base, t, opts.probeTerm) })
  }

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    if (!c) continue
    const tag = i < formCount ? `form:${c.template}` : c.template
    let html = ''
    try {
      html = await httpGet(c.url, { timeoutMs })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      errors.push(`${c.url}: ${reason}`)
      probes.push({ template: tag, url: c.url, state: 'inconclusive', reason: `请求失败：${reason.slice(0, 120)}` })
      continue
    }
    const verdict = looksLikeSearchResults(html, opts.probeTerm, opts.baselineHtml)
    const state: SearchProbeState = verdict.ok ? 'found' : 'not-found'
    probes.push({ template: tag, url: c.url, state, reason: verdict.reason })
    if (verdict.ok) return { probes, hit: { template: tag, url: c.url, html }, errors }
    await sleep(delayMs)
  }
  return { probes, errors }
}

/** 从 HTML 提同源链接（只要 URL；过滤交给调用方——单一真源） */
export function extractSameSiteLinks(html: string, pageUrl: string, base: string, max = 200): string[] {
  let baseHost = ''
  try {
    baseHost = new URL(base).hostname.replace(/^www\./, '')
  } catch {
    return []
  }
  const out: string[] = []
  const seen = new Set<string>()
  const re = /href\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < max) {
    const raw = m[1]
    if (!raw || raw.startsWith('javascript:') || raw.startsWith('#') || raw.startsWith('mailto:')) continue
    let abs: string
    try {
      abs = new URL(raw, pageUrl).toString()
    } catch {
      continue
    }
    const host = (() => {
      try {
        return new URL(abs).hostname.replace(/^www\./, '')
      } catch {
        return ''
      }
    })()
    if (host !== baseHost) continue
    const key = abs.split('#')[0] ?? abs
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

export interface ExpandOutcome {
  /** 从搜索结果页发现的同源链接（未过滤——调用方按自己的判据处理） */
  urls: string[]
  /** 实际用的种子词（按信息量排序） */
  terms: string[]
  probes: SearchProbe[]
  errors: string[]
}

/**
 * 用**种子词**迭代查询扩展 URL 前沿。
 *
 * 流程：`seedHtml`（已抓页面）→ 提取种子词 → 逐个查询 → 从结果页提取同源链接。
 * **只有前 N 个词会被查**（预算纪律），且**同一个词只查一次**。
 */
export async function expandViaSearch(
  base: string,
  seedHtml: string,
  opts: {
    template: string
    /** 种子词上限（默认 5） */
    maxTerms?: number
    /** 每个词的结果页链接上限（默认 40） */
    maxLinksPerTerm?: number
    timeoutMs?: number
    delayMs?: number
  },
): Promise<ExpandOutcome> {
  const maxTerms = opts.maxTerms ?? 5
  const maxLinksPerTerm = opts.maxLinksPerTerm ?? 40
  const timeoutMs = opts.timeoutMs ?? 20000
  const delayMs = opts.delayMs ?? 250

  const terms = extractSeedTerms(seedHtml, { limit: maxTerms })
  const urls: string[] = []
  const probes: SearchProbe[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  for (const term of terms) {
    const url = buildSearchUrl(base, opts.template, term)
    let html = ''
    try {
      html = await httpGet(url, { timeoutMs })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      errors.push(`${url}: ${reason}`)
      continue
    }
    const verdict = looksLikeSearchResults(html, term)
    probes.push({ template: opts.template, url, state: verdict.ok ? 'found' : 'inconclusive', reason: verdict.reason })
    for (const u of extractSameSiteLinks(html, url, base, maxLinksPerTerm)) {
      if (seen.has(u)) continue
      seen.add(u)
      urls.push(u)
    }
    await sleep(delayMs)
  }
  return { urls, terms, probes, errors }
}
