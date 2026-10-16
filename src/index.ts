/** dsh-search-pro：深度搜索插件——表层多引擎 / 深网挖掘 / Tor 代理 / 发现层（CC+crt.sh+爬取）/ 抽取层（附件→文本）/ 情报系统（工具数见运行时日志 `applied · N tools`，不在此写死） */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { buildQueries } from './buildQuery.js'
import { searchWeb, searchTavily, searchSerper } from './engines.js'
import { deepResearch } from './research.js'
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
import { discoverUrls, normalizeDomain } from './discover-fetch.js'
import { discoverSite } from './discover-site.js'
import { isAttachment, extOf } from './discover.js'
import { fetchDocument } from './document.js'
import { IntelStore } from './intel-store.js'
import { scanTarget, scanAll } from './intel-scan.js'
import { summarizeScans, intelStats, type IntelTarget } from './intel.js'
import { fileURLToPath } from 'node:url'
import {
  buildStamp, channelsOf, composeSearchEntry, formatChannels, readPackageVersion, searchTrace,
} from './trace.js'
import { SearchStore } from './store.js'

export const name = 'dsh-search-pro'
export const inject = ['tools', 'systemPrompt'] as const

export interface Config {
  enabled: boolean
  tavilyKey: string
  serperKey: string
  shodanKey: string
  securityTrailsKey: string
  githubToken: string
  jinaKey: string
  defaultLang: string
  /** SearXNG 自托管实例根地址（JSON API，无 key；只绑本机）——默认 http://127.0.0.1:18788 */
  searxngBase?: string
  /** SearXNG 就绪门：查询前探活 → 冷启 WSL VM → 幂等确保容器 → 轮询到就绪（默认开）。
   *  关掉它＝回到「VM 一关机通道就 0 条」的老样子（U10 事故形状）。 */
  searxngGate?: boolean
  /** 就绪等待预算（ms，默认 15000）。 */
  searxngReadyTimeoutMs?: number
  /** 冷启成功后留保活进程的分钟数（默认 120，0＝不留）——钉住 WSL VM，免被空闲回收。 */
  searxngKeepAliveMinutes?: number
  /** searxng 在单次聚合里的预算封顶（ms，默认 15000）——超时不拖住其它通道。 */
  searxngBudgetMs?: number
  cacheTtlMinutes?: number
  /** 情报定时扫描间隔（分钟，默认 360 = 6 小时；0 = 关闭定时扫描，只保留手动 intel_scan）。 */
  intelScanMinutes?: number
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
  searxngBase: z.string().default('http://127.0.0.1:18788'),
  searxngGate: z.boolean().default(true),
  searxngReadyTimeoutMs: z.number().default(15000),
  searxngKeepAliveMinutes: z.number().default(120),
  searxngBudgetMs: z.number().default(15000),
  cacheTtlMinutes: z.number().default(60),
  intelScanMinutes: z.number().default(360),
})

/** 单通道读数（工具结果里的 `channels[]`）——与 trace.ts 的 `channelsOf` 同形。 */
const channelsSchema = (): any => ({
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      engine: { type: 'string' },
      ok: { type: 'boolean' },
      count: { type: 'number' },
      ms: { type: 'number' },
      via: { type: 'string' },
      // 就绪门逐步判决（searxng 专用）：`probe-direct=ok@12ms ; boot-vm=ok@820ms ; ...`
      // 2026-10-02 修：此前 schema 不列此字段，即便上游传了也会被 output 校验剥掉。
      attempts: { type: 'string' },
      error: { type: 'string' },
    },
  },
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
  // 通道读数附注（2026-10-02 基线研究驱动）：`channels[]` 一直在返回值里，但 render 只渲染
  // `results` ⇒ 模型看不到「谁空手、为什么空手」，只能从结果条数反推（曾据此误判 searxng 是否恢复）。
  // 复用 trace.ts 的 channelsOf/formatChannels——脱敏与截断在同一真源，不另起一套格式化。
  const channels = channelsOf(v)
  const channelLine = channels.length === 0 ? '' : '\n\n通道读数：' + formatChannels(channels, 400)
  if (!v.ok) return [{ type: 'text', text: (v.error ?? '失败') + channelLine }]
  const rs = v.results ?? []
  if (rs.length === 0) return [{ type: 'text', text: (v.note ?? '无结果') + channelLine }]
  const body = rs.map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet ?? ''}`.trimEnd()).join('\n')
  return [{ type: 'text', text: body + channelLine }]
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

/**
 * 无损 JSON 化：DSH 工具返回值经校验，含 `undefined` 会报
 * 「value is not lossless JSON」（2026-10-16 实测：status/mime 为 undefined 时触发）。
 * 走一次 JSON 往返即把 undefined 字段剔除——这正是校验要求的语义。
 */
function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** 多源 URL 发现的渲染：源读数 + 附件单列（新增字段不渲染 = 等于没做） */
function renderDiscover(_a: any, v: any): any[] {
  if (!v.ok) return [{ type: 'text', text: v.error ?? '失败' }]
  const st = v.stats ?? {}
  const per = st.perSource ?? {}
  const srcLine = Object.keys(per).length
    ? Object.entries(per).map(([k, n]) => `${k}=${n}`).join(' · ')
    : '(无源读数)'
  const errLine = st.errorCount ? `\n⚠ 源错误 ${st.errorCount} 个：` + Object.entries(st.errors ?? {}).map(([k, m]) => `${k}: ${String(m).slice(0, 120)}`).join(' | ') : ''
  const head = `# 多源 URL 发现：${v.domain}\n源读数：${srcLine}${errLine}\n共 ${st.total ?? 0} 条 · 其中附件 ${st.attachments ?? 0} 个 · 尝试 ${v.attempts ?? 0} 次 · ${v.elapsedMs ?? 0}ms`
  const urls: any[] = v.results ?? []
  const atts = urls.filter((r: any) => r.isAttachment)
  const pages = urls.filter((r: any) => !r.isAttachment)
  const pageBody = pages.slice(0, 60).map((r: any, i: number) => {
    const meta = [r.source, r.status, r.mime].filter(Boolean).join(' ')
    return `${i + 1}. ${r.url}${meta ? `\n   [${meta}]` : ''}`
  }).join('\n')
  const attBody = atts.slice(0, 40).map((r: any, i: number) => `${i + 1}. ${r.url}`).join('\n')
  const parts = [head]
  if (pages.length) parts.push(`\n## 页面（${pages.length}，显示前 ${Math.min(60, pages.length)}）\n${pageBody}`)
  if (atts.length) parts.push(`\n## 附件（${atts.length}，显示前 ${Math.min(40, atts.length)}）—— 深网高价值目标\n${attBody}`)
  if (!pages.length && !atts.length) parts.push('\n(无结果)')
  return [{ type: 'text', text: parts.join('\n') }]
}

/** 站点发现的渲染：骨架四类 + sitemap 探测读数 */
function renderSiteDiscover(_a: any, v: any): any[] {
  if (!v.ok) return [{ type: 'text', text: v.error ?? '失败' }]
  const s = v.site ?? {}
  const st = s.stats ?? {}
  const rob = s.robots ?? {}
  const probes: any[] = s.sitemapProbes ?? []
  const probeLine = probes.length
    ? probes.map((p: any) => `${p.url.replace(/^https?:\/\//, '').split('/').slice(1).join('/') || '/'}=${p.ok ? `✓${p.bytes}B` : '✗'}`).join(' · ')
    : '(未探测)'
  const extLine = Object.keys(st.byExt ?? {}).length
    ? Object.entries(st.byExt).map(([k, n]) => `${k}×${n}`).join(' · ')
    : '无'
  const cov: any = s.coverage ?? {}
  const covLine = `覆盖度：${cov.confidence ?? '未知'}` + ((cov.basis ?? []).length ? `（${(cov.basis ?? []).join('；')}）` : '')
  const head = [
    `# 站点发现：${s.base}`,
    `robots.txt: ${rob.ok ? '✓' : '✗ ' + (rob.error ?? '')} · 其中 sitemap 线索 ${(rob.sitemaps ?? []).length} 条 · Disallow ${(rob.disallow ?? []).length} 条`,
    `sitemap 探测: ${probeLine}`,
    `爬取: 成功 ${st.fetched ?? 0} 页 · 失败 ${st.failed ?? 0} 页 · 最大深度 ${st.maxDepthReached ?? 0}`,
    `页面 ${(s.pages ?? []).length} · 附件 ${(s.attachments ?? []).length}（${extLine}）· feed ${(s.feeds ?? []).length}`,
    covLine,
  ].join('\n')
  const parts = [head]
  // 缺口清单紧跟头部（HALT 迁移：说清「没找到」与「找不到」的区别）
  if ((cov.gaps ?? []).length) {
    parts.push(
      '\n## 覆盖缺口（诚实清单——分清「没找到」与「找不到」）\n' +
        (cov.gaps as string[]).map((g, i) => `${i + 1}. ${g}`).join('\n'),
    )
  }
  const atts: string[] = s.attachments ?? []
  if (atts.length) parts.push(`\n## 附件清单（${atts.length}）—— 深网高价值目标\n` + atts.slice(0, 50).map((u, i) => `${i + 1}. ${u}`).join('\n'))
  const feeds: string[] = s.feeds ?? []
  if (feeds.length) parts.push(`\n## feed（${feeds.length}）\n` + feeds.slice(0, 10).map((u, i) => `${i + 1}. ${u}`).join('\n'))
  const pages: string[] = s.pages ?? []
  if (pages.length) parts.push(`\n## 页面（${pages.length}，显示前 40）\n` + pages.slice(0, 40).map((u, i) => `${i + 1}. ${u}`).join('\n'))
  const errs: string[] = s.errors ?? []
  if (errs.length) parts.push(`\n## 失败明细（前 10）\n` + errs.slice(0, 10).map((e, i) => `${i + 1}. ${String(e).slice(0, 160)}`).join('\n'))
  return [{ type: 'text', text: parts.join('\n') }]
}

export function apply(ctx: Context, config: Config): void {  const logger = ctx.logger('search-pro')
  // tavilyKey 单一来源（2026-09-06 凭据迁移）：config 优先（兼容旧配置）→ .credentials.yaml refs 兜底。
  if (!config.tavilyKey) {
    try {
      const cred = readFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml'), 'utf8')
      const m = cred.match(/^\s*TAVILY_API_KEY:\s*(\S+)/m)
      if (m && m[1]) config.tavilyKey = m[1]
    } catch { /* 无凭据文件 */ }
  }
  const store = new SearchStore((config.cacheTtlMinutes ?? 60) * 60_000)
  // 情报库：构造失败**不拖垮整个插件**（§5.24 逃逸异常 = 宿主死因）——降级成「情报工具响亮报错」
  let intelStore: IntelStore | null = null
  let intelInitError = ''
  try {
    intelStore = new IntelStore()
  } catch (e) {
    intelInitError = e instanceof Error ? e.message : String(e)
    logger.warn(`intel store 初始化失败：${intelInitError}（情报工具将报错而非静默）`)
  }
  /** 情报工具的统一不可用读数：把「空」与「坏了」分开（§5.10 静默失败 = 死亡温床） */
  const intelUnavailable = (): { ok: false; error: string } => ({
    ok: false,
    error: `情报库不可用：${intelInitError || '未知原因'}（库位置 ${join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'intel')}）`,
  })

  // ── 情报定时扫描（2026-10-16 · 让「情报系统」真的自己跑起来）──────────────
  // 设计要点：
  //  ① **到期检查而非直接定时**（§5.10 规则 2）：每分钟看一次「距上次扫描是否超间隔」，
  //     这样重启不会吞掉一次扫描（重启后第一分钟内就会补扫）。
  //  ② **状态落盘**：lastScanAt 写在 <DSH_HOME>/intel/status.json——它同时是到期判据的真源。
  //  ③ **绝不反噬主流程**（§5.24 逃逸异常 = 宿主死因）：整体 try/catch，失败只 warn。
  //  ④ unref()：不阻止进程退出。
  //  ⑤ **扫描是取数不是决策**——推送与否归主体（本定时器不碰 telegram）。
  const intelDir = intelStore?.dir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'intel')
  const intelStatusPath = join(intelDir, 'status.json')
  const readIntelStatus = (): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(intelStatusPath, 'utf8')) as Record<string, unknown>
    } catch {
      return null // 「还没有状态文件」与「文件坏了」都不该拖垮调用方——由调用方按 null 处理
    }
  }
  const writeIntelStatus = (patch: Record<string, unknown>): void => {
    try {
      writeFileSync(intelStatusPath, JSON.stringify({ ...(readIntelStatus() ?? {}), ...patch }, null, 1), 'utf8')
    } catch (e) {
      logger.warn(`情报状态写入失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const runIntelScan = async (reason: string): Promise<void> => {
    if (!intelStore) return
    try {
      if (intelStore.listTargets().length === 0) return
      const t0 = Date.now()
      const results = await scanAll(intelStore, { delayMs: 200 })
      const summary = summarizeScans(results)
      writeIntelStatus({
        lastScanAt: new Date().toISOString(),
        lastScanReason: reason,
        lastScanMs: Date.now() - t0,
        ...summary,
      })
      logger.info(
        `情报定时扫描（${reason}）：${summary.scanned} 目标 · 扫到 ${summary.foundTotal}`
        + ` · 新增 ${summary.newTotal} · 失败 ${summary.failedCount} · ${Date.now() - t0}ms`,
      )
    } catch (e) {
      logger.warn(`情报定时扫描失败（${reason}）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const intelIntervalMinutes = config.intelScanMinutes ?? 360
  if (intelStore && intelIntervalMinutes > 0) {
    const intelTimer = setInterval(() => {
      void (async () => {
        try {
          const st = readIntelStatus()
          const last = st?.lastScanAt ? Date.parse(String(st.lastScanAt)) : 0
          if (Number.isFinite(last) && Date.now() - last >= intelIntervalMinutes * 60_000) {
            await runIntelScan('timer')
          }
        } catch (e) {
          logger.warn(`情报到期检查失败：${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    }, 60_000)
    intelTimer.unref?.()
    logger.info(`情报定时扫描已装载：每 ${intelIntervalMinutes} 分钟（到期检查粒度 60s）`)
  }

  // ── 情报状态注入（2026-10-16）────────────────────────────────────────────
  // 让「有未读情报」这件事**主动到达我**，而不是靠我每轮想起来查 intel_list。
  // 机制：ctx.systemPrompt.context 的 text() 由 agent-loop 在**每次模型请求开头**物化。
  // 纪律：**无未读时不注入**（省 token）；有未读时只给一行 + 两个可执行入口。
  //       注入层绝不反噬主流程（§5.24）：整体 try/catch，失败返回空串。
  const intelContextDispose = ctx.systemPrompt.context({
    name: 'intel-status',
    order: 850,
    text: () => {
      try {
        if (!intelStore) return ''
        const pending = intelStore.listItems({ status: 'new', limit: 1 }).filtered
        if (pending === 0) return ''
        const st = readIntelStatus()
        const last = st?.lastScanAt ? localStamp(String(st.lastScanAt)) : '未扫过'
        return `情报库：${pending} 条未读 · 上次扫描 ${last}（intel_digest 看内容 / intel_scan 立刻扫）`
      } catch {
        return ''
      }
    },
  })
  ctx.effect(() => intelContextDispose, 'search-pro.intel-context')
  // ── 自证轨迹（可维护性 S4 · 2026-09-14 批次 S4-A）────────────────────────────
  // 单点收口：`reg` 是**全部工具的唯一注册入口**，故一个包装器覆盖整个工具面
  // （不在 N 处手改——漏一处就是新的观测盲区）。观测层零业务影响：
  // 返回值原样透出（output.schema 是 additionalProperties:false，绝不混入新字段）、
  // 业务异常原样重抛；落盘失败只吞不抛。
  const OWN_FILE = fileURLToPath(import.meta.url)
  /** 进程级构建自报 `<version>@<模块 mtime ms>`（Q1：线上跑的是哪个构建）。 */
  const BUILD = buildStamp(OWN_FILE, readPackageVersion(OWN_FILE))

  const tracedExecute = (tool: any) => {
    const inner = typeof tool?.execute === 'function' ? tool.execute.bind(tool) : null
    const op = String(tool?.name ?? 'unknown')
    return async (...callArgs: any[]) => {
      const startedAtMs = Date.now()
      let result: any
      let thrown: any = null
      try {
        result = inner ? await inner(...callArgs) : undefined
      } catch (err) {
        thrown = err
      }
      searchTrace(composeSearchEntry({
        now: startedAtMs, phase: 'call', build: BUILD, op, args: callArgs[0],
        durationMs: Date.now() - startedAtMs, result, thrown,
      }))
      if (thrown !== null) throw thrown
      return result
    }
  }

  // 工具计数用现算而非写死：写死的数字必然漂移（2026-10-16 实测：日志报 23、实际 24）
  let toolCount = 0
  const reg = (tool: any) => {
    toolCount += 1
    return ctx.tools.register(defineTool({ ...tool, execute: tracedExecute(tool) } as any))
  }

  // boot 行：字段与调用行完全同形（tail 后可直接读列）。
  searchTrace(composeSearchEntry({
    now: Date.now(), phase: 'boot', build: BUILD, op: 'apply', args: {}, durationMs: 0, result: { ok: true },
  }))

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
    description: '通用多引擎搜索（parallel=无钥匙·密集摘录 / searxng=自托管 / DuckDuckGo / Bing 免费 + 可选 Tavily/Serper API；**brave 实测 100% HTTP 429 已移出默认组**），聚合去重，并回报**逐通道读数**（channels：谁出结果、谁空手、为什么空手）。一次性多查询扇出用 extraQueries+objective（省掉链式重搜）。支持 timeRange 时间过滤（只对 duckduckgo 生效）搜新资源。长尾信息优先用 search_deep 系列。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索词' },
      engines: { type: 'array', items: { type: 'string', enum: ['parallel', 'searxng', 'duckduckgo', 'brave', 'bing', 'tavily', 'serper'] }, description: '引擎列表（默认 parallel+searxng+duckduckgo+bing；brave 已移出默认组）' },
      lang: { type: 'string', description: '语言提示' },
      pages: { type: 'number', description: '翻页深度 1-3（默认 1）' },
      objective: { type: 'string', description: 'Parallel：自然语言说明「要找什么」（缺省＝query）' },
      sessionId: { type: 'string', description: 'Parallel：稳定会话 id（免费档按它限速；同会话复用同一值）' },
      extraQueries: { type: 'array', items: { type: 'string' }, description: 'Parallel：与主查询一次性扇出的补充查询（≤3 条，比链式重搜便宜）' },
      timeRange: { type: 'string', description: '时间过滤（只对 duckduckgo 生效）：w=一周内 m=一月内 y=一年内，或 YYYY-MM-DD..YYYY-MM-DD 绝对区间。找新资源用' },
    },
    output: { schema: resultsSchema({ channels: channelsSchema() }), render: renderList },
    async execute(args: any) {
      const ck = `web:${args.query}:${(args.engines ?? []).join(',')}:${args.pages ?? 1}:${args.timeRange ?? ''}:${args.sessionId ?? ''}`
      const hit = store.get(ck)
      if (hit) return hit
      const channels: any[] = []
      const r = await safe(() => searchWeb({
        query: args.query, engines: args.engines, lang: args.lang ?? config.defaultLang,
        pages: args.pages, tavilyKey: config.tavilyKey, serperKey: config.serperKey, timeRange: args.timeRange,
        searxngBase: config.searxngBase, objective: args.objective, sessionId: args.sessionId, extraQueries: args.extraQueries,
        searxngGate: config.searxngGate, searxngReadyTimeoutMs: config.searxngReadyTimeoutMs,
        searxngKeepAliveMinutes: config.searxngKeepAliveMinutes, searxngBudgetMs: config.searxngBudgetMs,
      }, (s) => channels.push(s)))
      if (!r.ok) return { ok: false, error: r.error, channels }
      store.bump('search_web')
      const out = { ok: true, count: r.value.length, results: r.value, channels }
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

  /* ── B2 · 深研循环（L3）── */
  const deepSchema: any = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      query: { type: 'string' },
      queries: { type: 'array', items: { type: 'string' } },
      report: { type: 'string' },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            n: { type: 'number' }, title: { type: 'string' }, url: { type: 'string' },
            domain: { type: 'string' }, engines: { type: 'array', items: { type: 'string' } },
            excerpt: { type: 'string' }, content: { type: 'string' },
          },
        },
      },
      stats: {
        type: 'object',
        additionalProperties: false,
        properties: {
          engineCalls: { type: 'number' }, queries: { type: 'number' }, sources: { type: 'number' },
          fetched: { type: 'number' }, callsPerAnswer: { type: 'number' },
          rounds: { type: 'number' }, gapFilled: { type: 'number' },
          crossChecked: { type: 'number', description: '≥2 条通道独立命中的来源数（可信度提示）' },
        },
      },
      channels: channelsSchema(),
      routing: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' }, added: { type: 'array', items: { type: 'string' } }, note: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
  }

  reg({
    name: 'search_deep',
    description: '深研循环（一句话交付带引用报告）：查询扇出 → parallel/searxng/免费引擎并行 → 去重 + 域多样 → 抓正文 → 带 [n] 引用的 Markdown 报告；按**领域路由**自动追加 GitHub（代码类）或学术三源（研究类）；标注 ★多引擎一致 的来源；并回报「每答调用数」与**逐通道读数**（谁空手、为什么）。适合需要多源交叉核验的问题；简单查询仍用 search_web 快路径（更省调用）。',
    parameters: {
      query: { type: 'string', required: true, description: '研究问题（自然语言即可）' },
      objective: { type: 'string', description: 'Parallel：要找什么（缺省＝query）' },
      sessionId: { type: 'string', description: 'Parallel：稳定会话 id（免费档按它限速；同会话复用同一值）' },
      engines: { type: 'array', items: { type: 'string', enum: ['parallel', 'searxng', 'duckduckgo', 'brave', 'bing', 'tavily', 'serper'] }, description: '引擎集合（默认 parallel+searxng+duckduckgo）' },
      variants: { type: 'number', description: '扇出查询条数（默认 4）' },
      maxSources: { type: 'number', description: '纳入报告并抓正文的来源数（默认 5）' },
      fetch: { type: 'boolean', description: '是否抓正文（默认 true；false＝只用密集摘录，更快更省）' },
      routing: { type: 'string', enum: ['auto', 'off'], description: '领域路由（默认 auto：代码类问题追加 GitHub、研究类追加学术三源；off＝只用网页通道）' },
    },
    output: { schema: deepSchema, render: (_a: any, v: any) => [{ type: 'text', text: String(v?.report ?? (v?.ok ? 'ok' : 'error: ' + (v?.error ?? ''))) }] },
    async execute(args: any) {
      const ck = `deep:${args.query}:${(args.engines ?? []).join(',')}:${args.maxSources ?? 5}:${args.fetch ?? true}:${args.sessionId ?? ''}:${args.routing ?? 'auto'}`
      const hit = store.get(ck)
      if (hit) return hit
      const r = await safe(() => deepResearch({
        query: args.query, objective: args.objective, sessionId: args.sessionId,
        engines: args.engines, variants: args.variants, maxSources: args.maxSources, fetch: args.fetch,
        searxngBase: config.searxngBase, searxngGate: config.searxngGate,
        searxngReadyTimeoutMs: config.searxngReadyTimeoutMs, searxngKeepAliveMinutes: config.searxngKeepAliveMinutes,
        tavilyKey: config.tavilyKey, serperKey: config.serperKey, jinaKey: config.jinaKey,
        githubToken: config.githubToken, routing: args.routing,
      }))
      if (!r.ok) {
        return {
          ok: false, query: String(args.query ?? ''), queries: [], report: 'error: ' + r.error, sources: [],
          stats: { engineCalls: 0, queries: 1, sources: 0, fetched: 0, callsPerAnswer: 0, rounds: 0, gapFilled: 0, crossChecked: 0 },
          channels: [], routing: { kind: 'general', added: [], note: '未执行' }, error: r.error,
        }
      }
      store.bump('search_deep')
      store.set(ck, r.value)
      return r.value
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
      const t = await torStatus().catch(() => ({ ok: false, detail: 'Tor 检查失败', daemon: false, circuit: false }))
      const channels = store.countsSnapshot()
      const results = Object.entries(channels).map(([k, n]) => ({ title: k, url: '', snippet: `${n} 次调用` }))
      results.push({ title: '缓存', url: '', snippet: `${store.list().length} 条` })
      // 两级分别报：daemon(本地事实) 与 circuit(行为事实) —— 不许互相冒充
      results.push({ title: `Tor daemon ${t.daemon ? '✅' : '❌'}`, url: '', snippet: t.daemon ? 'SocksPort 9050 在监听' : '无监听（daemon 未起）' })
      results.push({ title: `Tor circuit ${t.circuit ? '✅' : '❌'}`, url: '', snippet: t.circuit ? `出网正常 · 出口 ${t.detail.split('出口 ')[1] ?? ''}` : 'daemon 在跑但出网失败（网桥/电路）' })
      results.push({ title: `Tor 总判 ${t.ok ? '✅' : '❌'}`, url: '', snippet: t.detail })
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

  reg({
    name: 'discover_urls',
    description: '多源 URL 发现：从一个域名挖出互联网档案里的已知 URL——Common Crawl（PB 级网页档案，128 个月度索引）+ crt.sh 证书透明日志。用于「不知道有什么」时的广度发现：子域、历史页面、附件清单。无需 API key。',
    parameters: {
      domain: { type: 'string', required: true, description: '域名（如 sues.edu.cn；也吃 URL 形态）' },
      sources: { type: 'array', description: '源：commoncrawl | crtsh | wayback（缺省 commoncrawl,crtsh；wayback 在大陆网络常被墙）' },
      limit: { type: 'number', description: '每源取多少条（缺省 50；Common Crawl 实测 >50 稳定 504）' },
      indexes: { type: 'array', description: 'Common Crawl 索引 id 列表（缺省最新一个；collinfo 共 128 个可选）' },
      onlyAttachments: { type: 'boolean', description: '只返回附件类 URL（pdf/docx/xlsx/pptx/…）' },
    },
    output: {
      schema: resultsSchema({
        domain: { type: 'string' },
        attempts: { type: 'number' },
        elapsedMs: { type: 'number' },
        stats: { type: 'object', additionalProperties: true },
        perIndex: { type: 'object', additionalProperties: true },
      }),
      render: renderDiscover,
    },
    async execute(args: any) {
      const r = await safe(() =>
        discoverUrls(args.domain, { sources: args.sources, limit: args.limit, indexes: args.indexes }),
      )
      if (!r.ok) return { ok: false, error: r.error }
      const v = r.value
      const list = args.onlyAttachments ? v.attachments : v.urls
      store.bump('discover_urls')
      return jsonSafe({
        ok: true,
        count: list.length,
        domain: v.domain,
        attempts: v.attempts,
        elapsedMs: v.elapsedMs,
        stats: v.stats,
        perIndex: v.perIndex,
        results: list.map((u) => ({
          url: u.url,
          source: u.source,
          status: u.status,
          mime: u.mime,
          isAttachment: isAttachment(u.url, u.mime),
        })),
      })
    },
  })

  reg({
    name: 'discover_site',
    description: '站点级发现：给一个站点列出内容骨架——robots.txt / sitemap 探测 / 站内页面 / 附件清单 / feed。用于系统性遍历站点（替代人工翻列表页）：深网内容常藏在附件里（如公示公告的 docx/xlsx）。',
    parameters: {
      url: { type: 'string', required: true, description: '站点 URL（如 https://tw.sues.edu.cn/）' },
      maxPages: { type: 'number', description: '最多访问页数（缺省 30，上界防爆炸）' },
      maxDepth: { type: 'number', description: '最大爬取深度（缺省 3）' },
      followPagination: { type: 'boolean', description: '是否跟随「下一页」分页链接（缺省 true）' },
    },
    output: {
      schema: resultsSchema({ site: { type: 'object', additionalProperties: true } }),
      render: renderSiteDiscover,
    },
    async execute(args: any) {
      const r = await safe(() =>
        discoverSite(args.url, {
          maxPages: args.maxPages,
          maxDepth: args.maxDepth,
          followPagination: args.followPagination,
        }),
      )
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('discover_site')
      const s = r.value
      return jsonSafe({
        ok: true,
        count: s.pages.length + s.attachments.length,
        site: s,
        results: [],
      })
    },
  })

  reg({
    name: 'fetch_document',
    description: '附件抽取：URL 或本地文件 → 统一文档模型（正文 + 结构化表格）。支持 docx/xlsx/pdf/xls/csv/tsv/html/txt。深网内容大量藏在附件里（公示公告的 docx/xlsx/pdf），本工具把附件变成可读文本。边界：扫描件 PDF 无文本层时只报 warnings（不做 OCR，未验证）；老式 .doc 需 antiword（本机 apt 依赖冲突未装上，会明确报出「暂不支持」）。',
    parameters: {
      url: { type: 'string', required: true, description: '附件 URL 或本地绝对路径' },
      maxRows: { type: 'number', description: '表格行数上界（缺省 2000，防一次吐爆上下文）' },
      timeoutMs: { type: 'number', description: '下载超时 ms（缺省 90000；大 PDF 实测需数十秒）' },
    },
    output: {
      schema: resultsSchema({ doc: { type: 'object', additionalProperties: true } }),
      render: renderDocument,
    },
    async execute(args: any) {
      const r = await safe(() => fetchDocument(args.url, { maxRows: args.maxRows, timeoutMs: args.timeoutMs }))
      if (!r.ok) return { ok: false, error: r.error }
      store.bump('fetch_document')
      return jsonSafe({ ok: true, count: 1, doc: r.value, results: [] })
    },
  })

  // ── 情报系统（2026-10-16 · 主人指令：用提升后的搜索能力搭情报系统）────────────
  // 四工具分工：watch=管目标 / scan=取增量 / list=查条目 / digest=出汇总。
  // 增量判据的真源是**快照**：落盘与快照更新在 scanTarget 同一函数内，防调用方忘记。

  reg({
    name: 'intel_watch',
    description: '情报监控目标管理：登记/列出/移除要持续监控的源（站点公告与附件、域名、arXiv 检索）。登记后用 intel_scan 扫描，只有**新增**条目会进 items 流。库位置 <DSH_HOME>/intel（targets.json + snapshots/ + items.jsonl）。',
    parameters: {
      action: { type: 'string', enum: ['add', 'list', 'remove', 'update'], description: 'add=登记（缺省） list=列出 remove=移除（快照一并清） update=改备注' },
      id: { type: 'string', description: '目标 id（add 缺省自动生成；remove/update 必填）' },
      kind: { type: 'string', enum: ['site', 'domain', 'arxiv'], description: 'add 必填：site=站点级发现（爬页面+附件） domain=多源 URL 发现（Common Crawl + crt.sh） arxiv=论文检索' },
      url: { type: 'string', description: 'kind=site：站点 URL' },
      domain: { type: 'string', description: 'kind=domain：域名' },
      query: { type: 'string', description: 'kind=arxiv：检索词' },
      note: { type: 'string', description: '备注（人读）' },
      maxPages: { type: 'number', description: 'site/arxiv 的条数上界（缺省 site 30 / arxiv 15）' },
      maxDepth: { type: 'number', description: 'site 最大爬取深度（缺省 3）' },
    },
    output: {
      schema: resultsSchema({
        targets: { type: 'array', items: { type: 'object', additionalProperties: true } },
        target: { type: 'object', additionalProperties: true },
        dir: { type: 'string' },
      }),
      render: renderIntelWatch,
    },
    async execute(args: any) {
      if (!intelStore) return intelUnavailable()
      const s = intelStore
      try {
        const action = args.action ?? 'add'
        if (action === 'list') {
          const targets = s.listTargets()
          return jsonSafe({ ok: true, count: targets.length, targets, dir: s.dir, results: [] })
        }
        if (action === 'remove') {
          if (!args.id) return { ok: false, error: 'remove 需要 id' }
          const done = s.removeTarget(args.id)
          return { ok: done, count: 0, note: done ? `已移除 ${args.id}（快照一并清掉，重加不会继承旧快照）` : `未找到目标 ${args.id}`, results: [] }
        }
        if (action === 'update') {
          if (!args.id) return { ok: false, error: 'update 需要 id' }
          const done = s.patchTarget(args.id, args.note === undefined ? {} : { note: args.note })
          return { ok: done, count: 0, note: done ? `已更新 ${args.id}` : `未找到目标 ${args.id}`, results: [] }
        }
        const kind = args.kind
        if (kind !== 'site' && kind !== 'domain' && kind !== 'arxiv') {
          return { ok: false, error: 'add 需要 kind（site | domain | arxiv）' }
        }
        const spec: IntelTarget['spec'] = {}
        if (kind === 'site') {
          if (!args.url) return { ok: false, error: 'kind=site 需要 url' }
          spec.url = args.url
          if (args.maxPages) spec.maxPages = args.maxPages
          if (args.maxDepth) spec.maxDepth = args.maxDepth
        } else if (kind === 'domain') {
          if (!args.domain) return { ok: false, error: 'kind=domain 需要 domain' }
          spec.domain = args.domain
        } else {
          if (!args.query) return { ok: false, error: 'kind=arxiv 需要 query' }
          spec.query = args.query
          if (args.maxPages) spec.maxPages = args.maxPages
        }
        const seed = String(spec.url ?? spec.domain ?? spec.query ?? '')
        const id = args.id ?? `${kind}-${seed.replace(/[^\w.\-]+/g, '_').slice(0, 60)}`
        const prev = s.getTarget(id)
        // 重加时清快照——否则新目标「继承」旧快照会让增量判据失真（与 removeTarget 同理）
        if (prev) s.clearSnapshot(id)
        const target: IntelTarget = {
          id, kind, spec,
          note: args.note ?? prev?.note,
          createdAt: prev?.createdAt ?? new Date().toISOString(),
          lastScanAt: prev?.lastScanAt,
          foundTotal: prev?.foundTotal,
        }
        s.upsertTarget(target)
        return jsonSafe({
          ok: true, count: 1, target,
          note: prev ? `已覆盖 ${id}（快照已清，下次扫描按全新目标算）` : `已登记 ${id}`,
          results: [],
        })
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  })

  reg({
    name: 'intel_scan',
    description: '扫描情报目标：按类型取数 → 与快照比对得出**增量** → 落盘 → 立即更新快照（报过的不会再报）。可扫一个（id）或全部。读数严格分型：state=ok 时 newCount 可为 0（真没新的）；state=failed 时 newCount 无意义（不许读成「0 条新增」）。',
    parameters: {
      id: { type: 'string', description: '目标 id（缺省=扫全部）' },
      maxPages: { type: 'number', description: 'site 目标页数上界覆盖（缺省用目标自带值或 30）' },
      delayMs: { type: 'number', description: '礼貌延迟 ms（缺省 150）' },
    },
    output: {
      schema: resultsSchema({
        scanned: { type: 'number' },
        okCount: { type: 'number' },
        failedCount: { type: 'number' },
        foundTotal: { type: 'number' },
        newTotal: { type: 'number' },
        failedTargets: { type: 'array', items: { type: 'string' } },
        failures: { type: 'array', items: { type: 'string' } },
        partialCount: { type: 'number' },
        partialTargets: { type: 'array', items: { type: 'string' } },
        sourceErrors: { type: 'array', items: { type: 'string' } },
        outcomes: { type: 'array', items: { type: 'object', additionalProperties: true } },
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }),
      render: renderIntelScan,
    },
    async execute(args: any) {
      if (!intelStore) return intelUnavailable()
      const s = intelStore
      try {
        const opts = { maxPages: args.maxPages, delayMs: args.delayMs }
        let results: Awaited<ReturnType<typeof scanAll>>
        if (args.id) {
          const t = s.getTarget(args.id)
          if (!t) return { ok: false, error: `未找到目标 ${args.id}（用 intel_watch action=list 看现有目标）` }
          results = [await scanTarget(t, s, opts)]
        } else {
          const all = s.listTargets()
          if (all.length === 0) {
            return jsonSafe({
              ok: true, count: 0, note: '尚无监控目标——先用 intel_watch action=add 登记',
              ...summarizeScans([]), outcomes: [], items: [], results: [],
            })
          }
          results = await scanAll(s, opts)
        }
        const summary = summarizeScans(results)
        const items = results.flatMap((r) => r.items)
        // 手动扫也更新 status：否则定时器不知道刚扫过，会立刻重复扫一遍（浪费 + 对源站不礼貌）
        writeIntelStatus({
          lastScanAt: new Date().toISOString(),
          lastScanReason: 'manual',
          lastScanMs: results.reduce((s, r) => s + r.elapsedMs, 0),
          ...summary,
        })
        store.bump('intel_scan')
        return jsonSafe({
          ok: true,
          count: items.length,
          ...summary,
          outcomes: results.map((r) => ({
            targetId: r.targetId, state: r.state, foundCount: r.foundCount, newCount: r.newCount,
            error: r.error, confidence: r.confidence, gaps: r.gaps, elapsedMs: r.elapsedMs,
            partial: r.partial, sourceErrors: r.sourceErrors,
          })),
          items,
          results: [],
        })
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  })

  reg({
    name: 'intel_list',
    description: '列情报条目：按发现时间降序，可按目标/状态过滤，并带统计（总数 / 按状态 / 按类型 / 按目标）。items.jsonl 的坏行数会响亮报出（文件被外力破坏过时不静默）。可选把某条标为某状态（itemId + setStatus）。',
    parameters: {
      id: { type: 'string', description: '只看某目标' },
      status: { type: 'string', enum: ['new', 'seen', 'starred', 'dropped'], description: '只看某状态' },
      limit: { type: 'number', description: '条数上限（缺省 50）' },
      itemId: { type: 'string', description: '（可选）要改状态的条目 id' },
      setStatus: { type: 'string', enum: ['new', 'seen', 'starred', 'dropped'], description: '（可选）改成的状态——与 itemId 同传' },
    },
    output: {
      schema: resultsSchema({
        stats: { type: 'object', additionalProperties: true },
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        badLines: { type: 'number' },
        filtered: { type: 'number' },
      }),
      render: renderIntelList,
    },
    async execute(args: any) {
      if (!intelStore) return intelUnavailable()
      const s = intelStore
      try {
        if (args.itemId && args.setStatus) {
          const done = s.updateStatus(args.itemId, args.setStatus)
          return { ok: done, count: 0, note: done ? `${args.itemId} → ${args.setStatus}` : `未找到条目 ${args.itemId}`, results: [] }
        }
        const loaded = s.listItems({ targetId: args.id, status: args.status, limit: args.limit ?? 50 })
        const stats = intelStats(s.loadItems().items, s.listTargets())
        store.bump('intel_list')
        return jsonSafe({
          ok: true, count: loaded.items.length,
          stats, items: loaded.items, badLines: loaded.badLines, filtered: loaded.filtered,
          results: [],
        })
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  })

  reg({
    name: 'intel_digest',
    description: '出情报汇总文本：本轮该看的条目（按目标分组）+ 统计 + 扫描健康。本工具**只出文本**（发送由 telegram_send 执行——推送与否归主体裁决）。markSeen=true 时把列出的条目标为 seen，下次 digest 不再重复。',
    parameters: {
      limit: { type: 'number', description: '每目标最多几条（缺省 10）' },
      status: { type: 'string', enum: ['new', 'seen', 'starred', 'dropped'], description: '取哪些状态（缺省 new）' },
      markSeen: { type: 'boolean', description: '出完是否标 seen（缺省 false）' },
    },
    output: {
      schema: resultsSchema({
        digest: { type: 'string' },
        stats: { type: 'object', additionalProperties: true },
        shown: { type: 'number' },
        marked: { type: 'number' },
      }),
      render: renderIntelDigest,
    },
    async execute(args: any) {
      if (!intelStore) return intelUnavailable()
      const s = intelStore
      try {
        const status = args.status ?? 'new'
        const perTarget = args.limit ?? 10
        const targets = s.listTargets()
        const loaded = s.listItems({ status, limit: 500 })
        const groups = new Map<string, any[]>()
        for (const it of loaded.items) {
          const arr = groups.get(it.targetId) ?? []
          if (arr.length < perTarget) arr.push(it)
          groups.set(it.targetId, arr)
        }
        const shown = [...groups.values()].reduce((n, a) => n + a.length, 0)
        const stats = intelStats(s.loadItems().items, targets)
        const lines: string[] = []
        lines.push(`# 情报汇总 · ${localStamp(new Date())}`)
        lines.push(`条目 ${stats.total} 条（${status} ${shown} 条待看）· 监控目标 ${stats.targets} 个`)
        if (loaded.badLines > 0) lines.push(`⚠ items.jsonl 有 ${loaded.badLines} 行无法解析`)
        const never = targets.filter((t) => !t.lastScanAt)
        if (never.length) lines.push(`⚠ 未扫过的目标 ${never.length} 个：${never.map((t) => t.id).join(', ')}`)
        if (shown === 0) {
          lines.push('')
          lines.push(targets.length === 0
            ? '（尚无监控目标——intel_watch action=add 登记后再 scan）'
            : `（无 ${status} 条目——扫过的都是已报过的，或还没扫）`)
        }
        for (const [tid, items] of groups) {
          lines.push('')
          lines.push(`## ${tid}（${items.length} 条）`)
          for (const it of items) {
            const tag = it.kind === 'attachment' ? '[附件]' : it.kind === 'paper' ? '[论文]' : '[页面]'
            lines.push(`${tag} ${it.title || it.url}`)
            if (it.title) lines.push(`   ${it.url}`)
          }
        }
        let marked = 0
        if (args.markSeen && shown > 0) {
          for (const arr of groups.values()) for (const it of arr) if (s.updateStatus(it.id, 'seen')) marked += 1
        }
        store.bump('intel_digest')
        return jsonSafe({ ok: true, count: shown, digest: lines.join('\n'), stats, shown, marked, results: [] })
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  })

  logger.info(`applied · ${toolCount} tools · cache ${config.cacheTtlMinutes ?? 60}min`)
}

/** 附件抽取渲染：正文 + 表格（表格是深网最有价值的结构化内容，不能只算不渲染） */
function renderDocument(_a: any, v: any): any[] {
  if (!v.ok) return [{ type: 'text', text: v.error ?? '失败' }]
  const d: any = v.doc ?? {}
  const warns: string[] = d.warnings ?? []
  const warnLine = warns.length ? '\n⚠ ' + warns.join(' | ') : ''
  const text = String(d.text ?? '')
  const head =
    `# 附件抽取：${d.source}\n` +
    `格式 ${d.kind} · ${((d.bytes ?? 0) / 1024).toFixed(1)}KB · 正文 ${text.length} 字 · ` +
    `表格 ${(d.tables ?? []).length} 个 · ${d.elapsedMs ?? 0}ms（${d.via ?? '?'}）${warnLine}`
  const parts = [head]
  if (text) parts.push('\n## 正文\n' + text.slice(0, 3000) + (text.length > 3000 ? '\n…（截断）' : ''))
  const tables: any[] = d.tables ?? []
  tables.slice(0, 3).forEach((t: any, i: number) => {
    let label = ''
    let rows: any[] = []
    if (Array.isArray(t)) {
      label = `表 ${i + 1}`
      rows = t
    } else if (t && Array.isArray(t.rows)) {
      label = `表 ${i + 1}「${t.sheet}」`
      rows = t.rows
    } else {
      return
    }
    const body = rows
      .slice(0, 15)
      .map((r: any) => (Array.isArray(r) ? r.join(' | ') : String(r)))
      .join('\n')
    parts.push(`\n## ${label}（${rows.length} 行，显示前 ${Math.min(15, rows.length)}）\n${body}`)
  })
  if (tables.length > 3) parts.push(`\n… 另有 ${tables.length - 3} 个表未显示`)
  return [{ type: 'text', text: parts.join('\n') }]
}

// ── 情报系统渲染（2026-10-16）─────────────────────────────────────────────
// 纪律：新字段必须渲染出来——只算不渲染 = 等于没做（read 回来看不见）。

/**
 * 本地时间戳（2026-10-16 修）：此前 render 直接用 ISO（UTC）——本地 22:59 显示成 14:59，
 * 差 8 小时且**没有任何标注**。**存 UTC 是对的，显示必须本地化**
 * （§5.9 规则 6：进结论的读数必须自带范围标注）。
 */
function localStamp(iso: unknown): string {
  const d = iso instanceof Date ? iso : new Date(String(iso ?? ''))
  if (Number.isNaN(d.getTime())) return String(iso ?? '')
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 目标渲染：目标是「我要盯什么」，故逐条列出 spec 与上次扫描时间 */
function renderIntelWatch(_a: any, v: any): any[] {
  if (!v.ok) return [{ type: 'text', text: v.error ?? '失败' }]
  const lines: string[] = []
  if (v.note) lines.push(v.note)
  const ts: any[] = v.targets ?? []
  if (ts.length) {
    lines.push(`## 监控目标（${ts.length}）`)
    for (const t of ts) {
      const spec = t.spec?.url ?? t.spec?.domain ?? t.spec?.query ?? '?'
      const last = t.lastScanAt ? `上次 ${localStamp(t.lastScanAt)}` : '未扫过'
      const extra = t.spec?.maxPages ? ` · 上界 ${t.spec.maxPages}` : ''
      lines.push(`· \`${t.id}\` [${t.kind}] ${spec}${extra} · ${last}${t.note ? ` · ${t.note}` : ''}`)
    }
  } else if (!v.target) {
    lines.push('（尚无监控目标——用 intel_watch action=add 登记）')
  }
  if (v.dir) lines.push(`库位置：${v.dir}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** 扫描渲染：逐目标读数 + 失败清单 + 新增条目。「无新增」与「失败」分开说 */
function renderIntelScan(_a: any, v: any): any[] {
  if (!v.ok) return [{ type: 'text', text: v.error ?? '失败' }]
  const partial = v.partialCount ? ` · ⚠部分源失败 ${v.partialCount}` : ''
  const parts = [`# 情报扫描：${v.scanned} 个目标 · 成功 ${v.okCount} · 失败 ${v.failedCount}${partial} · 扫到 ${v.foundTotal} · 新增 ${v.newTotal}`]
  if (v.note) parts.push(v.note)
  const outs: any[] = v.outcomes ?? []
  if (outs.length) {
    parts.push('')
    parts.push('## 逐目标读数')
    for (const o of outs) {
      const state = o.state === 'ok' ? '✅' : '❌'
      parts.push(`· ${state} \`${o.targetId}\` 扫到 ${o.foundCount} · 新增 ${o.newCount} · ${o.elapsedMs}ms`)
      if (o.error) parts.push(`  ⚠ ${o.error}`)
      if (o.partial) parts.push('  ⚠ 部分源失败（扫到的是剩余源的结果，读数可能缩水）')
      if (Array.isArray(o.sourceErrors)) {
        for (const e of o.sourceErrors) parts.push(`    ✗ ${e}`)
      }
      if (o.confidence) parts.push(`  置信度 ${o.confidence}`)
      if (Array.isArray(o.gaps) && o.gaps.length) {
        // gaps **全显示**（2026-10-16 修）：此前只显示前 3 条，把「队列仍有 N 个未访问」
        // 这类关键提示截掉了——而那正是「附件为 0」的原因所在。
        for (const g of o.gaps) parts.push(`  缺口：${g}`)
      }
    }
  }
  const failures: string[] = v.failures ?? []
  if (failures.length) {
    parts.push('')
    parts.push(`## ⚠ 失败（${failures.length}）`)
    for (const f of failures) parts.push(`· ${f}`)
  }
  const items: any[] = v.items ?? []
  if (items.length) {
    parts.push('')
    parts.push(`## 新增条目（${items.length}）`)
    for (const it of items.slice(0, 20)) {
      const tag = it.kind === 'attachment' ? '[附件]' : it.kind === 'paper' ? '[论文]' : '[页面]'
      parts.push(`· ${tag} ${it.title || it.url}${it.source ? ` (${it.source})` : ''}`)
    }
    if (items.length > 20) parts.push(`… 另有 ${items.length - 20} 条`)
  } else if (v.okCount > 0) {
    parts.push('')
    parts.push('（本轮无新增——扫到的都是已报过的）')
  }
  return [{ type: 'text', text: parts.join('\n') }]
}

/** 条目渲染：统计在头、条目在身、坏行响亮 */
function renderIntelList(_a: any, v: any): any[] {
  if (!v.ok) return [{ type: 'text', text: v.error ?? '失败' }]
  const s: any = v.stats ?? {}
  const parts = [`# 情报条目：${s.total ?? 0} 条 · 监控目标 ${s.targets ?? 0} 个`]
  if (v.badLines) parts.push(`⚠ items.jsonl 有 ${v.badLines} 行无法解析（文件被外力破坏过）`)
  const fmt = (o: any) => Object.entries(o ?? {}).map(([k, n]) => `${k} ${n}`).join(' · ')
  const byStatus = fmt(s.byStatus)
  const byKind = fmt(s.byKind)
  if (byStatus) parts.push(`状态：${byStatus}`)
  if (byKind) parts.push(`类型：${byKind}`)
  const items: any[] = v.items ?? []
  if (items.length) {
    parts.push('')
    parts.push(`## 条目（显示 ${items.length} · 命中 ${v.filtered ?? items.length}）`)
    for (const it of items) {
      const when = localStamp(it.foundAt)
      parts.push(`· [${it.kind}/${it.status}] ${when} \`${it.targetId}\``)
      if (it.title) parts.push(`  ${it.title}`)
      parts.push(`  ${it.url}`)
    }
  } else {
    parts.push('')
    parts.push('（无匹配条目）')
  }
  return [{ type: 'text', text: parts.join('\n') }]
}

/** digest 渲染：文本即交付（可直接 telegram_send 推） */
function renderIntelDigest(_a: any, v: any): any[] {
  if (!v.ok) return [{ type: 'text', text: v.error ?? '失败' }]
  const tail = v.marked ? `\n\n（已标记 ${v.marked} 条为 seen）` : ''
  return [{ type: 'text', text: String(v.digest ?? '（空）') + tail }]
}
