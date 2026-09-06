/** dsh-search-pro：三层深度搜索插件（表层多引擎 / 深网挖掘 / Tor 代理）· 23 工具 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { buildQueries } from './buildQuery.js'
import { searchWeb, searchTavily, searchSerper } from './engines.js'
import {
  searchAcademic, searchPatent, searchGithub, searchCommunity,
  lookupWhois, enumSubdomains, lookupDnsHistory, searchShodan,
  type AcademicSource, type CommunityPlatform,
} from './deep.js'
import { cdxSearch, archiveRestore } from './archive.js'
import { fetchPage, fetchTor, torStatus } from './fetch.js'
import { searchNetdisk, searchMagnet, type ShareResult } from './share.js'
import { searchCode, searchDarkweb, checkPasswordLeak } from './osint.js'
import { fetchRobust } from './robust.js'
import { SearchStore } from './store.js'

export const name = 'dsh-search-pro'
export const inject = ['tools'] as const

export interface Config {
  enabled: boolean
  tavilyKey: string
  serperKey: string
  shodanKey: string
  securityTrailsKey: string
  githubToken: string
  jinaKey: string
  defaultLang: string
  cacheTtlMinutes?: number
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  tavilyKey: z.string().default(''),
  serperKey: z.string().default(''),
  shodanKey: z.string().default(''),
  securityTrailsKey: z.string().default(''),
  githubToken: z.string().default(''),
  jinaKey: z.string().default(''),
  defaultLang: z.string().default('zh'),
  cacheTtlMinutes: z.number().default(60),
})

const resultsSchema = (extra: Record<string, unknown> = {}): any => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    count: { type: 'number' },
    results: { type: 'array', items: { type: 'object', additionalProperties: true } },
    error: { type: 'string' },
    note: { type: 'string' },
    ...extra,
  },
})

// 注意：dsh-tools 的 render 签名是 (args, value) => content——第一个参数是执行参数，第二个才是 execute 返回值！
function renderList(_a: any, v: any): any[] {
  if (!v.ok) return [{ type: 'text', text: v.error ?? '失败' }]
  const rs = v.results ?? []
  if (rs.length === 0) return [{ type: 'text', text: v.note ?? '无结果' }]
  return [{ type: 'text', text: rs.map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet ?? ''}`.trimEnd()).join('\n') }]
}

function renderContent(_a: any, v: any): any[] {
  if (!v.ok) return [{ type: 'text', text: v.error ?? '失败' }]
  const r = v.results?.[0]
  if (!r) return [{ type: 'text', text: v.note ?? '无结果' }]
  return [{ type: 'text', text: `# ${r.title}\n来源: ${r.url}\n\n${(r.content ?? '').slice(0, 4000)}` }]
}

/** 分享资源渲染：磁力链接完整展示（magnet 是核心交付物，不能截断） */
function renderShare(_a: any, v: any): any[] {
  if (!v.ok) return [{ type: 'text', text: v.error ?? '失败' }]
  const rs = v.results ?? []
  if (rs.length === 0) return [{ type: 'text', text: v.note ?? '无结果' }]
  return [{ type: 'text', text: rs.map((r: any, i: number) => {
    const meta = [r.size, r.seeders ? `种子 ${r.seeders}` : null, r.source].filter(Boolean).join(' · ')
    return `${i + 1}. ${r.title}\n   ${r.magnet ? `磁力: ${r.magnet}` : r.url}${meta ? `\n   ${meta}` : ''}`
  }).join('\n') }]
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('search-pro')
  // tavilyKey 单一来源（2026-09-06 凭据迁移）：config 优先（兼容旧配置）→ .credentials.yaml refs 兜底。
  if (!config.tavilyKey) {
    try {
      const cred = readFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml'), 'utf8')
      const m = cred.match(/^\s*TAVILY_API_KEY:\s*(\S+)/m)
      if (m && m[1]) config.tavilyKey = m[1]
    } catch { /* 无凭据文件 */ }
  }
  const store = new SearchStore((config.cacheTtlMinutes ?? 60) * 60_000)
  const reg = (tool: any) => ctx.tools.register(defineTool(tool as any))

  const safe = async <T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    try {
      return { ok: true, value: await fn() }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  /* ── A · 查询准备组 ── */
  reg({
    name: 'search_build_query',
    description: '查询改写：意图+关键词 → 多组查询变体（原词/短语/问题式/核心词），可选注入深挖语法（site:/filetype:/排除）。返回可直接用于各 search 工具的查询列表。',
    parameters: {
      intent: { type: 'string', required: true, description: '搜索意图描述' },
      keywords: { type: 'string', required: true, description: '核心关键词（空格分隔）' },
      lang: { type: 'string', description: '语言（zh/en，默认配置 defaultLang）' },
      grammarBoost: { type: 'boolean', description: '是否注入深挖语法变体' },
      site: { type: 'string', description: '限定站点（与 grammarBoost 配合）' },
      filetype: { type: 'string', description: '限定文件类型（如 pdf/docx，与 grammarBoost 配合）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const queries = buildQueries({
        intent: args.intent, keywords: args.keywords,
        lang: args.lang ?? config.defaultLang ?? 'zh',
        grammarBoost: args.grammarBoost, site: args.site, filetype: args.filetype,
      })
      if (!queries.length) return { ok: false, error: 'keywords 为空' }
      store.bump('build_query')
      return { ok: true, count: queries.length, results: queries.map((q) => ({ query: q, title: q, url: '', snippet: '查询变体' })) }
    },
  })

  /* ── B · 表层检索组 ── */
  reg({
    name: 'search_web',
    description: '通用多引擎搜索（DuckDuckGo/Brave/Bing 免费 + 可选 Tavily/Serper API），聚合去重。支持 timeRange 时间过滤（只对 duckduckgo 生效）搜新资源。长尾信息优先用 search_deep 系列。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索词' },
      engines: { type: 'array', items: { type: 'string', enum: ['duckduckgo', 'brave', 'bing', 'tavily', 'serper'] }, description: '引擎列表（默认 duckduckgo+brave）' },
      lang: { type: 'string', description: '语言提示' },
      pages: { type: 'number', description: '翻页深度 1-3（默认 1）' },
      timeRange: { type: 'string', description: '时间过滤（只对 duckduckgo 生效）：w=一周内 m=一月内 y=一年内，或 YYYY-MM-DD..YYYY-MM-DD 绝对区间。找新资源用' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const ck = `web:${args.query}:${(args.engines ?? []).join(',')}:${args.pages ?? 1}:${args.timeRange ?? ''}`
      const hit = store.get(ck)
      if (hit) return hit
      const r = await safe(() => searchWeb({
        query: args.query, engines: args.engines, lang: args.lang ?? config.defaultLang,
        pages: args.pages, tavilyKey: config.tavilyKey, serperKey: config.serperKey, timeRange: args.timeRange,
      }))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('search_web')
      const out = { ok: true, count: r.value.length, results: r.value }
      store.set(ck, out)
      return out
    },
  })

  reg({
    name: 'search_serp',
    description: '专业 SERP API 补强/保底（Tavily 带正文摘要 / Serper=Google 实时）。需要对应 API key（Config）。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索词' },
      provider: { type: 'string', enum: ['tavily', 'serper'], description: '通道（默认 tavily）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const provider = args.provider ?? 'tavily'
      if (provider === 'tavily') {
        if (!config.tavilyKey) return { ok: false, error: '未配置 tavilyKey（Config）' }
        const r = await safe(() => searchTavily(args.query, config.tavilyKey!, 8))
        if (!r.ok) return { ok: false, error: r.error }
        store.bump('tavily')
        return { ok: true, count: r.value.length, results: r.value }
      }
      if (!config.serperKey) return { ok: false, error: '未配置 serperKey（Config）' }
      const r = await safe(() => searchSerper(args.query, config.serperKey!, 10))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('serper')
      return { ok: true, count: r.value.length, results: r.value }
    },
  })

  reg({
    name: 'search_site',
    description: '站内定向搜索（site: 语法封装，走多引擎）。如搜 github.com / reddit.com / 具体论坛。',
    parameters: {
      site: { type: 'string', required: true, description: '目标站点域名（如 github.com）' },
      query: { type: 'string', required: true, description: '搜索词' },
      engines: { type: 'array', items: { type: 'string', enum: ['duckduckgo', 'bing', 'serper'] }, description: '引擎列表' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const engines = args.engines ?? (config.serperKey ? ['serper'] : ['duckduckgo'])
      const ck = `site:${args.site}:${args.query}:${engines.join(',')}`
      const hit = store.get(ck)
      if (hit) return hit
      const r = await safe(() => searchWeb({
        query: `site:${args.site} ${args.query}`, engines,
        serperKey: config.serperKey, tavilyKey: config.tavilyKey,
      }))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('search_site')
      const out = { ok: true, count: r.value.length, results: r.value.filter((x) => x.url.includes(args.site)) }
      store.set(ck, out)
      return out
    },
  })

  /* ── C · 深网挖掘组 ── */
  reg({
    name: 'search_academic',
    description: '学术文献检索：Semantic Scholar / arXiv / Crossref / OpenAlex（可指定源或全源并行）。论文/引用/DOI/预印本。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词' },
      source: { type: 'string', enum: ['semantic', 'arxiv', 'crossref', 'openalex'], description: '指定源（默认全部）' },
      limit: { type: 'number', description: '每源条数（默认 8）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const ck = `academic:${args.query}:${args.source ?? 'all'}:${args.limit ?? 8}`
      const hit = store.get(ck)
      if (hit) return hit
      const r = await safe(() => searchAcademic(args.query, args.source as AcademicSource | undefined, args.limit ?? 8))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('academic')
      const out = { ok: true, count: r.value.length, results: r.value }
      store.set(ck, out)
      return out
    },
  })

  reg({
    name: 'search_patent',
    description: '专利检索（对 Google Patents 定向搜索，走 SERP 或 Bing；配 serperKey 更准）。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词（技术方案/关键词）' },
      limit: { type: 'number', description: '条数（默认 8）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const r = await safe(() => searchPatent(args.query, config.serperKey, args.limit ?? 8))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('patent')
      return { ok: true, count: r.value.length, results: r.value }
    },
  })

  reg({
    name: 'search_github',
    description: 'GitHub 检索：代码/仓库/issue。注意：code 搜索必须配 githubToken（未认证 GitHub API 禁止 code search）。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词（可带 qualifiers，如 repo:user/name 关键词）' },
      type: { type: 'string', enum: ['code', 'repo', 'issue'], description: '类型（默认 repo）' },
      limit: { type: 'number', description: '条数（默认 8）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const r = await safe(() => searchGithub(args.query, args.type ?? 'repo', config.githubToken, args.limit ?? 8))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('github')
      return { ok: true, count: r.value.length, results: r.value }
    },
  })

  reg({
    name: 'search_community',
    description: '社区定向：Reddit / Hacker News / 4chan（board 参数）/ Telegram 公开频道（channel 参数）。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词' },
      platform: { type: 'string', enum: ['reddit', 'hn', '4chan', 'telegram'], description: '指定平台（默认全部适用源）' },
      board: { type: 'string', description: '4chan 版面（如 g/tv/b，默认 g）' },
      channel: { type: 'string', description: 'Telegram 公开频道用户名（如 channel_name，不含 @）' },
      limit: { type: 'number', description: '条数（默认 10）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const r = await safe(() => searchCommunity(
        args.query, args.platform as CommunityPlatform | undefined,
        { board: args.board, channel: args.channel }, args.limit ?? 10,
      ))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('community')
      return { ok: true, count: r.value.length, results: r.value }
    },
  })

  reg({
    name: 'lookup_whois',
    description: '域名注册情报（RDAP，免费）：注册商/状态/时间线/名称服务器/注册人 handle。',
    parameters: { domain: { type: 'string', required: true, description: '域名（如 example.com）' } },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const r = await safe(() => lookupWhois(args.domain))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('whois')
      const v = r.value as any
      const detail = Object.entries(v.extra ?? {})
        .filter(([, val]) => val)
        .map(([k, val]) => `${k}: ${val}`)
        .join(' · ')
      return { ok: true, count: 1, results: [{ title: v.title, url: v.url, snippet: `${v.snippet}\n${detail}` }] }
    },
  })

  reg({
    name: 'enum_subdomains',
    description: '子域名枚举（crt.sh Certificate Transparency，免费）：证书透明日志反查某域名的全部子域名。',
    parameters: {
      domain: { type: 'string', required: true, description: '目标域名' },
      limit: { type: 'number', description: '条数上限（默认 30）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const r = await safe(() => enumSubdomains(args.domain, args.limit ?? 30))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('subdomains')
      return { ok: true, count: r.value.length, results: r.value }
    },
  })

  reg({
    name: 'lookup_dns_history',
    description: 'DNS 历史记录（SecurityTrails，需 securityTrailsKey 免费额度）：A 记录时间线，看 IP 变迁。',
    parameters: { domain: { type: 'string', required: true, description: '目标域名' } },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      if (!config.securityTrailsKey) return { ok: false, error: '未配置 securityTrailsKey（Config）' }
      const r = await safe(() => lookupDnsHistory(args.domain, config.securityTrailsKey!))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('dns_history')
      const v = r.value as any
      return { ok: true, count: 1, results: [{ title: v.title, url: v.url, snippet: v.snippet }] }
    },
  })

  reg({
    name: 'search_shodan',
    description: 'Shodan 暴露服务/设备检索（需 shodanKey 免费额度）：找公网暴露的设备/服务指纹。',
    parameters: {
      query: { type: 'string', required: true, description: 'Shodan 查询（如 apache country:CN / port:22）' },
      limit: { type: 'number', description: '条数（默认 8）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      if (!config.shodanKey) return { ok: false, error: '未配置 shodanKey（Config）' }
      const r = await safe(() => searchShodan(args.query, config.shodanKey!, args.limit ?? 8))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('shodan')
      return { ok: true, count: r.value.length, results: r.value }
    },
  })

  /* ── D · 档案与还原组 ── */
  reg({
    name: 'archive_search',
    description: 'Wayback Machine 快照清单查询（CDX API）：某 URL/域名有哪些历史快照（可找回被删/改版页面）。',
    parameters: {
      url: { type: 'string', required: true, description: 'URL 或域名' },
      from: { type: 'string', description: '起始日期 YYYYMMDD' },
      to: { type: 'string', description: '结束日期 YYYYMMDD' },
      limit: { type: 'number', description: '条数（默认 20）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const r = await safe(() => cdxSearch(args.url, args.from, args.to, args.limit ?? 20))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('archive_search')
      return {
        ok: true, count: r.value.length,
        results: r.value.map((s) => ({
          title: `${s.timestamp} 快照`,
          url: `https://web.archive.org/web/${s.timestamp}/${s.url}`,
          snippet: `status: ${s.statuscode}`,
        })),
      }
    },
  })

  reg({
    name: 'archive_restore',
    description: '快照还原：取 Wayback 指定/最近快照并提取正文（找回被删页面的内容）。可配 archive.today 兜底。',
    parameters: {
      url: { type: 'string', required: true, description: '目标 URL' },
      timestamp: { type: 'string', description: '指定快照时间 YYYYMMDDhhmmss（默认最近一次）' },
    },
    output: { schema: resultsSchema(), render: renderContent },
    async execute(args: any) {
      const r = await safe(() => archiveRestore(args.url, args.timestamp))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('archive_restore')
      return {
        ok: true, count: 1,
        results: [{ title: `快照还原: ${args.url}`, url: r.value.snapshot, content: r.value.content }],
      }
    },
  })

  /* ── E · 内容处理组 ── */
  reg({
    name: 'fetch_page',
    description: '正文提取：URL → 可读正文。三级降级（Jina Reader → 自抓启发式提取）。可选 raw 模式返回原始 HTML。',
    parameters: {
      url: { type: 'string', required: true, description: '目标 URL' },
      mode: { type: 'string', enum: ['reader', 'raw'], description: 'reader=正文（默认） raw=原始 HTML' },
    },
    output: { schema: resultsSchema(), render: renderContent },
    async execute(args: any) {
      const r = await safe(() => fetchPage(args.url, args.mode ?? 'reader', config.jinaKey))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('fetch_page')
      return { ok: true, count: 1, results: [{ ...r.value }] }
    },
  })

  reg({
    name: 'fetch_tor',
    description: '经 Tor 网络抓取（需 WSL2 内 tor daemon 运行）。用于 .onion 站点或被墙公开内容。边界：只读文本，不协助非法内容。',
    parameters: {
      url: { type: 'string', required: true, description: '目标 URL（.onion 或普通）' },
      mode: { type: 'string', enum: ['reader', 'raw'], description: 'reader=正文（默认） raw=原始 HTML' },
    },
    output: { schema: resultsSchema(), render: renderContent },
    async execute(args: any) {
      const r = await safe(() => fetchTor(args.url, args.mode ?? 'reader'))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('fetch_tor')
      return { ok: true, count: 1, results: [{ ...r.value }] }
    },
  })

  reg({
    name: 'fetch_robust',
    description: '反爬绕过抓取（多通道降级）：直连指纹伪装 → cookie 预热 → 退避重试 → headless Chrome 执行 JS challenge。用于绕过搜索引擎/公开站的自动化访问限制（DDG anomaly、429 限流、Cloudflare challenge）。返回正文 + 命中通道 + 反爬诊断。边界：只用于公开信息检索，不绕过付费墙/认证/入侵。',
    parameters: {
      url: { type: 'string', required: true, description: '目标 URL' },
      skipHeadless: { type: 'boolean', description: '跳过 headless 通道（默认 false；明确不想起浏览器时用）' },
    },
    output: { schema: resultsSchema(), render: renderContent },
    async execute(args: any) {
      const ck = `robust:${args.url}:${args.skipHeadless ?? false}`
      const hit = store.get(ck)
      if (hit) return hit
      const r = await safe(() => fetchRobust(args.url, { skipHeadless: args.skipHeadless }))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('fetch_robust')
      const v = r.value
      const out = {
        ok: true, count: 1,
        results: [{
          title: `[${v.channel}] ${v.title || args.url}`,
          url: v.url,
          content: v.content,
          note: `通道: ${v.channel} · 反爬诊断: ${v.challenge}\n尝试: ${v.attempts.map((a) => `${a.channel}=${a.status}${a.ok ? '✓' : '✗'}`).join(' → ')}`,
        }],
      }
      store.set(ck, out)
      return out
    },
  })

  /* ── G · 分享资源检索组（网盘 + 磁力链接）── */
  reg({
    name: 'search_share',
    description: '分享资源检索：网盘（百度/阿里/夸克 site 定向）+ 磁力链接（Torlock Torznab API + The Pirate Bay 多源聚合）。找网盘分享、BT 种子、磁力链接用。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词（如 电影名/软件名/书名）' },
      kind: { type: 'string', enum: ['netdisk', 'magnet', 'all'], description: 'netdisk=网盘 magnet=磁力 all=两者（默认 all）' },
      domains: { type: 'array', items: { type: 'string' }, description: '网盘域名限定（默认 pan.baidu.com/aliyundrive.com/alipan.com/pan.quark.cn）' },
      limit: { type: 'number', description: '条数上限（默认 15）' },
    },
    output: { schema: resultsSchema(), render: renderShare },
    async execute(args: any) {
      const kind = args.kind ?? 'all'
      const limit = args.limit ?? 15
      const r = await safe(async () => {
        const out: ShareResult[] = []
        if (kind === 'netdisk' || kind === 'all') {
          const nd = await searchNetdisk(args.query, args.domains, limit)
          out.push(...nd.map((x) => ({ ...x, source: x.source })))
        }
        if (kind === 'magnet' || kind === 'all') {
          const mg = await searchMagnet(args.query, limit)
          out.push(...mg)
        }
        return out.slice(0, limit)
      })
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('search_share')
      const out = { ok: true, count: r.value.length, results: r.value }
      store.set(`share:${args.query}:${kind}`, out)
      return out
    },
  })

  /* ── H · 隐秘信息检索组（OSINT）── */
  reg({
    name: 'search_code',
    description: '代码敏感信息搜索（Sourcegraph，免费无需 key）：搜 GitHub 等公开仓库代码里的硬编码密钥/凭据/内部域名/API key。如搜 "aws_secret_access_key"、"BEGIN RSA PRIVATE KEY"、某内部域名。返回仓库/文件路径/命中行。',
    parameters: {
      query: { type: 'string', required: true, description: '代码搜索词（Sourcegraph 语法，如 aws_secret_access_key / password= 空值 / 内部域名；可加 lang:Python 等）' },
      limit: { type: 'number', description: '条数上限（默认 15）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const ck = `code:${args.query}:${args.limit ?? 15}`
      const hit = store.get(ck)
      if (hit) return hit
      const r = await safe(() => searchCode(args.query, args.limit ?? 15))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('search_code')
      const out = {
        ok: true, count: r.value.length,
        results: r.value.map((c) => ({
          title: `${c.repository} · ${c.path}:${c.lineNumber}`,
          url: c.url,
          snippet: `${c.line}${c.stars ? `\n⭐ ${c.stars}` : ''}`,
        })),
      }
      store.set(ck, out)
      return out
    },
  })

  reg({
    name: 'search_darkweb',
    description: '暗网索引搜索（Ahmia clearnet 版，无需 Tor）：搜 Tor 隐藏服务（.onion）标题/描述，返回真实 .onion 地址。边界：只返回公开索引，不协助非法内容。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词（如 bitcoin / market / forum）' },
      limit: { type: 'number', description: '条数上限（默认 15）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      const ck = `darkweb:${args.query}:${args.limit ?? 15}`
      const hit = store.get(ck)
      if (hit) return hit
      const r = await safe(() => searchDarkweb(args.query, args.limit ?? 15))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('search_darkweb')
      const out = { ok: true, count: r.value.length, results: r.value.map((d) => ({ title: d.title, url: d.url, snippet: `${d.snippet}\n源: ${d.source}` })) }
      store.set(ck, out)
      return out
    },
  })

  reg({
    name: 'search_leaks',
    description: '泄露密码自查（HIBP Pwned Passwords，k-anonymity 设计，免费无需 key）：查某密码是否出现在已知数据泄露中（返回出现次数）。用于安全自查/测试密码，只查单条不批量。',
    parameters: {
      password: { type: 'string', required: true, description: '要自查的密码明文（只本地算 SHA-1 前缀后传输，不落盘）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      if (!args.password) return { ok: false, error: 'password 为空' }
      const r = await safe(() => checkPasswordLeak(args.password))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('search_leaks')
      const l = r.value
      return {
        ok: true, count: 1,
        results: [{
          title: l.leaked ? `⚠ 该密码已泄露（出现 ${l.count} 次）` : '✅ 未在已知泄露库中',
          url: `https://haveibeenpwned.com/Passwords`,
          snippet: `SHA-1: ${l.hash}（前缀 ${l.prefix} 查询）`,
        }],
      }
    },
  })

  /* ── F · 系统管理组 ── */
  reg({
    name: 'search_quota',
    description: '通道配额/健康状态：本会话各通道调用计数、缓存规模、Tor 可达性。',
    parameters: {},
    output: { schema: resultsSchema({ channels: { type: 'object', additionalProperties: true } }), render: renderList },
    async execute() {
      const t = await torStatus().catch(() => ({ ok: false, detail: 'Tor 检查失败' }))
      const channels = store.countsSnapshot()
      const results = Object.entries(channels).map(([k, n]) => ({ title: k, url: '', snippet: `${n} 次调用` }))
      results.push({ title: '缓存', url: '', snippet: `${store.list().length} 条` })
      results.push({ title: `Tor ${t.ok ? '✅' : '❌'}`, url: '', snippet: t.detail })
      return { ok: true, count: results.length, results, channels }
    },
  })

  reg({
    name: 'search_cache',
    description: '结果缓存管理：list 查看缓存条目 / clear 清空（可带关键词过滤）。',
    parameters: {
      action: { type: 'string', enum: ['list', 'clear'], description: 'list=查看（默认） clear=清空' },
      query: { type: 'string', description: '过滤关键词（clear 时可选）' },
    },
    output: { schema: resultsSchema(), render: renderList },
    async execute(args: any) {
      if (args.action === 'clear') {
        const n = store.clear(args.query)
        return { ok: true, count: 0, note: `已清空 ${n} 条缓存`, results: [] }
      }
      const entries = store.list()
      return {
        ok: true, count: entries.length,
        results: entries.slice(0, 50).map((e) => ({ title: e.key, url: '', snippet: `${(e.size / 1024).toFixed(1)}KB · TTL ${e.ttlSec}s` })),
      }
    },
  })

  logger.info(`applied · 23 tools · cache ${config.cacheTtlMinutes ?? 60}min`)
}
