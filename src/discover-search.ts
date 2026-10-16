/**
 * 站内搜索接口探测与种子词扩展 —— 纯函数层（2026-10-16 · 论文迁移）。
 *
 * 来源：**Harnessing the Deep Web: Present and Future**（CIDR 2009 · arXiv:0909.1785）
 *   · **种子词生成**：从该站**已索引页面**里挑最具特征的词当查询词，迭代探测扩展 URL 前沿
 *   · **只需判定输入框的数据类型即可，不必理解表单语义**
 *   · **只有 GET 可索引，POST 不行**（结构性边界——本模块只做 GET）
 *   · **生成 URL 数 ∝ 底层数据库大小，而非查询组合数** ⇒ 选 N 个高特征词，**不穷举查询词**
 *
 * 本文件只放纯函数（可离线测）；网络 IO 在 discover-search-fetch.ts。
 *
 * 设计边界（如实）：
 *   · **JS 渲染型**搜索结果页拿不到（无 headless）⇒ 探测会判否，不是 bug
 *   · **POST 型**搜索做不到 ⇒ 探测会判否
 *   · 中文用 n-gram 而非分词器（零安装成本；且站点领域词分词器本就不认识）
 */

/** 常见站内搜索路径模板（GET；`{q}` 为查询词占位）。按「更可能命中」排序。 */
export const SEARCH_PATH_TEMPLATES: readonly string[] = [
  '/search?q={q}',
  '/search?keyword={q}',
  '/search?wd={q}',
  '/search?query={q}',
  '/search?word={q}',
  '/search/?q={q}',
  '/s?q={q}',
  '/so?q={q}',
  '/?s={q}',
  '/search.htm?q={q}',
  '/searchresult?q={q}',
]

/** 停用词：中文高频虚词 + 英文功能词——种子词提取要滤掉（否则「的」「和」会成为查询词） */
const STOPWORDS = new Set([
  '的', '了', '和', '是', '在', '有', '与', '及', '或', '为', '对', '从', '到', '把', '被',
  '这', '那', '你', '我', '他', '她', '它', '们', '个', '上', '下', '中', '大', '小', '不',
  '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '年', '月', '日', '时', '分',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'you', 'your',
  'our', 'its', 'has', 'have', 'been', 'will', 'can', 'not', 'but', 'all', 'any', 'more',
])

/** 剥标签 + 解实体（够用即可，不做完整 HTML 解析） */
export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取某标签的文本内容（首个命中） */
function firstTagText(html: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = re.exec(html)
  return m ? stripTags(m[1] ?? '') : ''
}

/** 取全部某标签的文本内容 */
function allTagTexts(html: string, tag: string, max = 20): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < max) {
    const t = stripTags(m[1] ?? '')
    if (t) out.push(t)
  }
  return out
}

/** 取全部链接锚文本（上限防爆） */
export function linkTexts(html: string, max = 60): string[] {
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < max) {
    const t = stripTags(m[1] ?? '')
    if (t.length >= 2 && t.length <= 30) out.push(t)
  }
  return out
}

/**
 * 从一段文本里抽候选词。
 * · 中文：连续 CJK 片段切 **2–4 字 n-gram**（不依赖分词器）
 * · 英文/数字：`[A-Za-z][A-Za-z0-9-]{2,}`
 * · 滤停用词、纯数字、超短
 */
export function termsFromText(text: string): string[] {
  const out: string[] = []
  const cjkRuns = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
  for (const run of cjkRuns) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const term = run.slice(i, i + n)
        if (!STOPWORDS.has(term)) out.push(term)
      }
    }
  }
  const latin = text.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? []
  for (const w of latin) {
    const low = w.toLowerCase()
    if (!STOPWORDS.has(low) && !/^\d+$/.test(low)) out.push(w)
  }
  return out
}

/**
 * 从 HTML 提取**种子词**（按「来源权重 × 词频 × 长度」排序取 top N）。
 *
 * 来源权重（论文的「已索引页面里最具特征的词」落地）：标题 3 > h1–h3 2 > 链接文本 1。
 */
export function extractSeedTerms(html: string, opts: { limit?: number } = {}): string[] {
  const limit = opts.limit ?? 8
  const score = new Map<string, number>()
  const add = (text: string, weight: number) => {
    for (const t of termsFromText(text)) {
      score.set(t, (score.get(t) ?? 0) + weight)
    }
  }
  add(firstTagText(html, 'title'), 3)
  for (const tag of ['h1', 'h2', 'h3']) {
    for (const t of allTagTexts(html, tag)) add(t, 2)
  }
  for (const t of linkTexts(html)) add(t, 1)

  return [...score.entries()]
    // 长度也是特征度的一部分（论文：挑「最具特征」的词，长词更具体）
    .map(([term, s]) => ({ term, s: s * Math.min(term.length, 6) }))
    .sort((a, b) => b.s - a.s || a.term.localeCompare(b.term))
    .slice(0, limit)
    .map((x) => x.term)
}

/** 把模板里的 `{q}` 换成编码后的查询词 */
export function buildSearchUrl(base: string, template: string, term: string): string {
  const b = base.replace(/\/+$/, '')
  return b + template.replace('{q}', encodeURIComponent(term))
}

/**
 * 判断响应是否**像**搜索结果页（而不是 404 / 首页原样 / 空壳）。
 *
 * 判据（三条都要，宁可判否——S2G-RAG 的「宁欠报」方向）：
 *  ① HTTP 状态是 2xx（由调用方保证，这里只看内容）
 *  ② 内容与「首页基线」**有实质差异**（同长度且同开头 ⇒ 判否）
 *  ③ 出现「结果结构」信号之一：查询词回显 / 列表项 / 分页 / 结果计数措辞
 *
 * ⚠ 这是**启发式**，不是语义理解——误判率未标定，故调用方必须把探测结果**如实报出**
 *   （「发现搜索接口」/「未发现」/「疑似但不确定」三态），不得静默当成确定事实。
 */
export function looksLikeSearchResults(
  html: string,
  term: string,
  baselineHtml = '',
): { ok: boolean; reason: string } {
  const body = stripTags(html)
  // ⚠ 长度**只作无信号时的兜底**，不作硬门槛（2026-10-16 实测抓出）：
  // 真实搜索结果页 stripTags 后可能只有 45 字，用「长度 ≥80」当门槛会把**真阳性**挡掉
  // ——这是「判据比对象严」的缺陷，不是样本的问题。尸体①（404 页）短**且无信号** ⇒ 仍判否。
  const tooShort = body.length < 80

  if (baselineHtml) {
    const base = stripTags(baselineHtml)
    if (base.length > 0 && body.length > 0) {
      const sameHead = body.slice(0, 400) === base.slice(0, 400)
      const lenRatio = body.length / base.length
      if (sameHead && lenRatio > 0.9 && lenRatio < 1.1) {
        return { ok: false, reason: '与首页基线几乎相同（查询词未生效，可能是静态首页）' }
      }
    }
  }

  const signals: string[] = []
  if (body.includes(term)) signals.push('查询词回显')
  if (/<li\b/i.test(html) && (html.match(/<li\b/gi) ?? []).length >= 5) signals.push('列表项≥5')
  if (/(下一页|下页|尾页|共\s*\d+\s*页|共\s*\d+\s*条|找到\s*\d+|约\s*\d+\s*条)/.test(body)) {
    signals.push('分页/计数措辞')
  }
  if (/(搜索?结果|检索结果|search\s+results?)/i.test(body)) signals.push('结果标题措辞')

  if (signals.length === 0) {
    return {
      ok: false,
      reason: tooShort
        ? '内容过短且无结果结构信号（可能是空壳或错误页）'
        : '无结果结构信号（可能无结果或非搜索页）',
    }
  }
  return { ok: true, reason: `命中信号：${signals.join('、')}` }
}

/** 探测结果的**三态**（不许把「疑似」说成「确定」） */
export type SearchProbeState = 'found' | 'not-found' | 'inconclusive'

export interface SearchProbe {
  template: string
  url: string
  state: SearchProbeState
  reason: string
}
