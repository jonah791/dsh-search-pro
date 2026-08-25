/** 查询改写：意图 → 多组查询变体 + 深挖语法注入 */

export interface BuildQueryArgs {
  intent: string
  keywords: string
  lang?: string
  grammarBoost?: boolean
  site?: string
  filetype?: string
}

/** 生成查询变体：原词 / 短语 / 问题式 / 精简式，可选注入深挖语法 */
export function buildQueries(args: BuildQueryArgs): string[] {
  const kw = args.keywords.trim()
  if (!kw) return []
  const out: string[] = []

  // 1. 原词（干净版）
  out.push(kw)

  // 2. 精确短语版
  const phrase = `"${kw}"`
  out.push(phrase)

  // 3. 精简核心词版（去停用词/修饰）
  const core = kw
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^(的|了|是|在|与|和|及|how|to|the|a|an|for|of|in|on)$/i.test(w))
    .join(' ')
  if (core && core !== kw) out.push(core)

  // 4. 问题式（中英）
  if (!/^[a-zA-Z\s]+$/.test(kw)) {
    out.push(`什么是 ${kw}`)
    out.push(`${kw} 教程 指南`)
  } else {
    out.push(`what is ${kw}`)
    out.push(`${kw} tutorial guide`)
  }

  // 5. 深挖语法注入
  if (args.grammarBoost) {
    if (args.site) out.push(`site:${args.site} ${kw}`)
    if (args.filetype) out.push(`${kw} filetype:${args.filetype}`)
    if (args.lang === 'zh') {
      out.push(`${kw} 知乎`)
      out.push(`${kw} 博客园`)
    } else {
      out.push(`intitle:${kw}`)
      out.push(`${kw} -wikipedia`)
    }
  }

  // 去重
  return [...new Set(out)].slice(0, 8)
}
