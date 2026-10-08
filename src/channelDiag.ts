/**
 * 通道「0 条」现场快照（诊断埋点 · 2026-10-08 · 工单 t-6bee3fd0 第 1 步）。
 *
 * 为什么单独一个文件、不进 `search-trace.jsonl`
 * --------------------------------------------------
 * 调用轨迹（`search-trace.jsonl`）的条目键序是**固定**的（`serializeTraceEntry`），
 * phase 只有 `call` / `boot` 两种，且被统计消费方按 op/phase 聚合。
 * 把「异常现场特征」挤进那条链有两个风险：键被序列化器丢掉，或污染 phase/op 计数。
 * ⇒ 「调用轨迹」与「异常现场」是**两类产物**：前者每次都写，后者**只在 0 条时写、只给下次判据用**。
 *
 * 判据纪律（工单明确要求）
 * --------------------------------------------------
 * 此处**只记录现象，不改行为**：看到 0 条 ⇒ 落一份现场，绝不据此抛错或改变检索结果。
 * 等现场样本攒到、判据写成形，才在§「行为修正」那一步改读数语义（那是后续步骤，不在本文件）。
 *
 * 观测不反噬（AGENTS.md §5.24）
 * --------------------------------------------------
 * 写盘失败一律吞掉并返回 `false`，**绝不抛**；调用点不得因埋点失败而改变检索行为。
 * 纯决策层（分类）与薄 I/O 层（追加）分离：分类可离线用尸体样本单测。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveHome } from './trace.js'

/** 现场快照条目（一行 JSON）。 */
export interface ChannelDiagEntry {
  atMs: number
  /** 通道名（`duckduckgo` / `parallel`）。 */
  engine: string
  /** 形状分类（见 `classify*Zero`；`unknown` 一律保留原始特征，不吞）。 */
  shape: string
  /** 查询（截断 200；查询不是凭据，可记）。 */
  query: string
  /** 该通道本次耗时（ms）。 */
  elapsedMs: number
  /** 原始特征（各形状不同；只放可判读的量，不放整页正文）。 */
  features: Record<string, unknown>
}

/** 现场快照路径（纯函数；与 `searchTracePath` 同目录）。 */
export function channelDiagPath(home: string): string {
  return join(home, 'search-channel-diag.jsonl')
}

const DDG_TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i
/** 弱信号：泛化词（可能命中页面样板文本，故只作 `anomaly-hint`）。 */
const DDG_ANOMALY_HINT_RE = /anomaly|unusual traffic|challenge|are you a robot/i
/**
 * 强信号：反爬页的**结构性标记**（2026-10-08 由真实现场标定）。
 *
 * 实证来源（工单 t-6bee3fd0）：把 DDG 打到风控后取回原页，得到
 * `<form id="img-form" action="//duckduckgo.com/anomaly.js?…&cc=botnet&…">`、
 * `<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>`、
 * `<title>DuckDuckGo</title>`、`len=14235`（正常页 32–35K）、`blocks=0`。
 * ⇒ 这些标记出现时**无需推断**：这就是反爬页，不是「查询无结果」。
 */
const DDG_ANOMALY_STRONG_RE = /anomaly\.js|anomaly-modal|cc=botnet|bots use duckduckgo too/i
const DDG_NORESULT_RE = /no\s+results|did not match|没有找到|找不到|未找到/i

/** 从页面里抽出命中的**强标记**（用于现场快照的 `anomalyMarkers`，比布尔值可判读）。 */
export function ddgAnomalyMarkers(html: string): string[] {
  const out: string[] = []
  const probes: Array<[string, RegExp]> = [
    ['anomaly.js', /anomaly\.js/i],
    ['anomaly-modal', /anomaly-modal/i],
    ['cc=botnet', /cc=botnet/i],
    ['bots-use-ddg', /bots use duckduckgo too/i],
  ]
  for (const [name, re] of probes) if (re.test(html)) out.push(name)
  return out
}

/**
 * 分类 DDG「解析 0 条」的现场形状（纯函数）。
 *
 * 五种形状的**判别意义不同**，这是埋点存在的理由——只知道「0 条」修不了：
 * · `anomaly` **强标记**命中（`anomaly.js` / `anomaly-modal` / `cc=botnet` / bots-use-ddg）
 *   ⇒ 反爬页，**不是「查询无结果」**（2026-10-08 由真实现场标定，见 `DDG_ANOMALY_STRONG_RE`）
 * · `no-results-text` 明确的「无结果」文案 ⇒ **真 0 结果**（此时记 ok:0 是诚实的）
 * · `no-blocks` 连结果块都没有、也没有无结果文案 ⇒ 页面结构变了（选择器失效）
 * · `blocks-no-anchors` 有块无锚点 ⇒ 同上，但更局部（可能是版式微调）
 * · `all-ads-filtered` 有锚点但解析出的条数为 0 ⇒ 全被判为广告/不可用链接
 *
 * ⚠ 判据顺序是**判据的一部分**：`no-results-text` 必须排在 `no-blocks` 之前——
 * 真无结果页本来就没有结果块，后置会把它误判成「结构变了」，两者修法完全不同。
 * `anomaly` 排在最前：它是唯一有**结构性证据**的形状，其余都靠「缺什么」推断。
 *
 * @param parsed 调用方解析器实际得到的条数（未传 = -1 = 无法判 `all-ads-filtered`）。
 */
export function classifyDdgZero(html: string, parsed = -1): { shape: string; features: Record<string, unknown> } {
  const blocks = html.split(/<div[^>]*class="[^"]*result[^"]*"/i).length - 1
  const resultA = (html.match(/class="result__a"/gi) ?? []).length
  const title = (html.match(DDG_TITLE_RE)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const anomalyMarkers = ddgAnomalyMarkers(html)
  const features: Record<string, unknown> = {
    len: html.length,
    blocks,
    resultA,
    parsed,
    title,
    anomaly: anomalyMarkers.length > 0,
    /** 命中的**强标记**清单（可判读，比布尔值有用）。 */
    anomalyMarkers,
    /** 泛化词的弱信号（可能命中页面样板文本；只作旁证，不单独判形状）。 */
    anomalyHint: DDG_ANOMALY_HINT_RE.test(html),
    noResultsText: DDG_NORESULT_RE.test(html),
  }
  let shape = 'unknown'
  if (anomalyMarkers.length > 0) shape = 'anomaly'
  else if (features.noResultsText === true) shape = 'no-results-text'
  else if (blocks === 0) shape = 'no-blocks'
  else if (resultA === 0) shape = 'blocks-no-anchors'
  else if (parsed === 0) shape = 'all-ads-filtered'
  return { shape, features }
}

/** `parallel` 响应体的可得量（调用点从各 return [] 的分支取值）。 */
export interface ParallelZeroInput {
  /** `data.result.content[0].text` 是否是字符串（否 ⇒ 响应形状变了）。 */
  hasText: boolean
  /** 文本长度（有 text 时）。 */
  textLen: number
  /** 文本开头 160 字符（判「是不是 SSE 流」用：`data: {...}` 形态）。 */
  textHead: string
  /** `JSON.parse(text)` 是否成功。 */
  parseOk: boolean
  /** `payload.results` 的原始条数。 */
  resultsRaw: number
  /** 过 `.filter(r => r.url)` 之后剩下的条数。 */
  afterFilter: number
}

/**
 * 分类 `parallel`「0 条」的现场形状（纯函数）。
 *
 * 关键：该函数有三处**静默** `return []`，形状不同、修法不同——
 * · `no-text-node` 响应里没有 text 节点 ⇒ MCP 契约变了
 * · `text-not-json` 有文本但不是 JSON ⇒ **最可疑**：请求头带 `accept: text/event-stream`，
 *   若服务端回 SSE（`data: {...}` 行），`JSON.parse` 必然抛 ⇒ 秒回 `ok:0`（实测 ~1000ms 与成功态
 *   1099–7778ms 明显不同）。此形状的 `textHead` 是判据的关键证据。
 * · `empty-results` 解析成功但 `results` 为空 ⇒ 真 0 结果（记 ok:0 诚实）
 * · `all-filtered` 有结果但全无 `url` ⇒ 字段名变了（`r.url` 不再存在）
 */
export function classifyParallelZero(i: ParallelZeroInput): { shape: string; features: Record<string, unknown> } {
  const features: Record<string, unknown> = {
    hasText: i.hasText,
    textLen: i.textLen,
    textHead: i.textHead,
    parseOk: i.parseOk,
    resultsRaw: i.resultsRaw,
    afterFilter: i.afterFilter,
  }
  let shape = 'unknown'
  if (!i.hasText) shape = 'no-text-node'
  else if (!i.parseOk) shape = 'text-not-json'
  else if (i.resultsRaw === 0) shape = 'empty-results'
  else if (i.afterFilter === 0) shape = 'all-filtered'
  return { shape, features }
}

/**
 * 追加一行现场快照。**失败即吞并返回 `false`**（观测绝不反噬检索）。
 * 路径：**显式 `opts.home` 优先**，否则 `<DSH_HOME>/search-channel-diag.jsonl`。
 *
 * ⚠ 优先级不是细节：初版写成 `resolveHome(env, home)`（env 赢），于是单元测试传入的
 * 临时目录被环境里的 `DSH_HOME` 盖掉 ⇒ **测试往生产侧车写数据**（夹具碰生产资产）。
 * 与本插件 `searchTrace` 的既有约定一致：显式路径 > 环境推导。
 */
export function appendChannelDiag(
  entry: ChannelDiagEntry,
  opts: { home?: string; env?: Record<string, string | undefined> } = {},
): boolean {
  try {
    const home = opts.home ?? resolveHome(opts.env ?? process.env)
    const path = channelDiagPath(home)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ ...entry, query: entry.query.slice(0, 200) }) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}
