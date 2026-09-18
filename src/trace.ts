/**
 * 检索面自证轨迹（可维护性 S4 证据层 · 2026-09-14 批次 S4-A）。
 *
 * 动机：本插件有 **24 个工具**，每次调用的真实经过（走了哪个引擎 / 反爬通道链走到哪一级 /
 * 聚合去重后剩多少条 / 耗时多久 / 断在哪一段）**只写 `ctx.logger`**，而宿主 logger **不落盘**。
 * 更贵的是本插件曾有一个真缺陷：`catch {}` 吞掉了 ESM 下必抛的 `require`，导致每次 headless
 * 调用泄漏一个 `%TEMP%\dsh-robust-<ts>` 目录（实测 15 个 / 每个 ~12MB），**而日志一片干净**——
 * 「降级到哪一级、哪一级失败了」当时完全不可见（AGENTS.md §5.22 / 技能 C9）。
 *
 * 修法：每次工具调用落一行 JSONL 侧车——`<DSH_HOME>/search-trace.jsonl`。
 * 阶段枚举：`boot`（进程级构建自报）→ `call`（任一工具的一次调用）。
 *
 * 轨迹回答的五问（技能 plugin-maintainability 判据）：
 *   Q1 线上跑哪个构建 → `build`（`<version>@<模块 mtime ms>`）
 *   Q2 谁发起         → `op`（23 个工具名之一）+ `params`（**白名单参数摘要，已脱敏**）
 *   Q3 断在哪一段      → `ok` / `error` / `channel`（反爬通道链的**命中级别**）+ `attempts`
 *   Q4 结果质量        → `count`（**聚合去重后的条数**）
 *   Q5 耗时与预算      → `durationMs`
 *
 * 观测绝不反噬主流程（技能 C4）：全部 IO 失败吞错并返回 `false`——写不进去也不影响检索。
 *
 * **隐私红线**：`params` 只取**白名单键**（query/url/domain/term/site/board/channel…），
 * 且任何键名命中 `/pass|secret|token|key|cookie|auth|credential|session/i` 一律**记都不记**；
 * 值再过 `redactText`。`search_leaks` 的 `password` 参数因此**永不落盘**（§7 有尸体测试）。
 *
 * @module dsh-search-pro/trace
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 阶段枚举：一次进程从 boot 起，每次工具调用一行。 */
export type SearchTracePhase = 'boot' | 'call'

/** 一行检索轨迹。字段**固定**（boot 行用中性值填充），便于 `tail` 后直接读列。 */
export interface SearchTraceEntry {
  /** 写入时刻（ms epoch）。 */
  atMs: number
  phase: SearchTracePhase
  /** 构建标识 `<version>@<模块 mtime ms>`（Q1）。 */
  build: string
  /** 工具名（23 个之一；boot 行为 `apply`）。 */
  op: string
  /** 参数摘要（**白名单键 + 脱敏 + 截断 200**；`key=value` 以 `;` 分隔）。 */
  params: string
  /** 聚合去重后的结果条数（Q4）。 */
  count: number
  /** 反爬通道链命中的级别（`fetchRobust` 的 `channel`；未走该链为空串，Q3）。 */
  channel: string
  /** 反爬通道尝试次数（`attempts.length`，Q3：走到了第几级）。 */
  attempts: number
  /** **逐通道读数**（Q3/Q4 的 per-channel 版本，2026-09-18 第二轮）：`engine=ok:12@1840ms/direct ; …`。
   *  聚合类工具（`search_web` / `search_deep`）带 `channels[]` 时才有内容；空串＝该工具没有多通道语义。 */
  channels: string
  /** 调用耗时（ms；boot=0）。 */
  durationMs: number
  /** 是否成功（结果体 `ok===false` 或有非空 `error` 或抛错 → false）。 */
  ok: boolean
  /** 失败原因（工具 error 文案，**已过 `redactText` + 截断 500**）。 */
  error?: string
}

/** 参数摘要白名单：**只有这些键**才可能进轨迹（其余一律不记，无需判断是否敏感）。 */
export const SUBJECT_KEYS: readonly string[] = [
  'query', 'keywords', 'intent', 'url', 'domain', 'term', 'pattern', 'site', 'board',
  'channel', 'field', 'lib', 'id', 'type', 'mode', 'lang', 'filetype', 'site_',
  'imageA', 'imageB', 'path', 'timestamp', 'timeRange', 'engines', 'limit', 'count',
]

/**
 * 凭据键名黑名单：**命中即整键丢弃**（连长度都不记）。
 * 与白名单是**双保险**——`search_leaks` 的 `password` 不在白名单里，同时也命中此黑名单。
 */
export const SECRET_KEY_RE = /pass|secret|token|key|cookie|auth|credential|session|nonce|signature/i

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（单一真源——**不要在多处各写一份**）。 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  fallback = homedir(),
): string {
  const raw = env['DSH_HOME']
  return raw !== undefined && raw.trim() !== '' ? raw : join(fallback, '.dsh')
}

/** 轨迹文件路径（纯函数）。 */
export function searchTracePath(home: string): string {
  return join(home, 'search-trace.jsonl')
}

/** 文件 mtime（ms；不可得为 0）。 */
export function mtimeOf(file: string): number {
  try {
    return Math.round(statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/** 从 `<file>` 所在包的 package.json 读版本（读不到返回空串，不抛）。 */
export function readPackageVersion(file: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 构建标识 `<version>@<模块 mtime ms>`（版本缺失退化为 `unknown@<mtime>`）。 */
export function buildStamp(file: string, version = ''): string {
  return version !== '' ? `${version}@${String(mtimeOf(file))}` : `unknown@${String(mtimeOf(file))}`
}

/** 文本截断（摘要用；超长补省略号）。 */
export function truncate(text: string, max = 200): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/**
 * 凭据脱敏（纯函数，**隐私红线**）：值层面按形状擦除。
 * 覆盖：显式键值对、`Bearer`、厂商前缀（`sk-`/`ghp_`/`github_pat_`/`AKIA`）、≥32 位高熵串。
 */
export function redactText(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?<![A-Za-z0-9])(api[_-]?key|token|secret|password|passwd|passphrase|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
}

/** 单值 → 摘要片段（数组按 `|` 连；对象记类型占位，不递归展开）。 */
export function valueDigest(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => (typeof v === 'object' && v !== null ? '{…}' : String(v)))
    return items.join('|')
  }
  if (value === null) return 'null'
  if (typeof value === 'object') return '{…}'
  return String(value)
}

/**
 * 参数摘要（纯函数，**Q2 的输入侧**）：**白名单键 + 黑名单键名**双闸 + 值脱敏 + 总量截断 200。
 * 键顺序按白名单序（稳定，便于 diff 轨迹行）。无任何可记键 → 空串（不是 `{}`）。
 */
export function paramsDigest(args: unknown, maxLen = 200): string {
  if (args === null || typeof args !== 'object') return ''
  const src = args as Record<string, unknown>
  const parts: string[] = []
  for (const key of SUBJECT_KEYS) {
    if (SECRET_KEY_RE.test(key)) continue          // 白名单里若有敏感名也丢（双保险）
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    const value = src[key]
    if (value === undefined || value === '') continue
    parts.push(`${key}=${valueDigest(value)}`)
  }
  return truncate(redactText(parts.join(';')), maxLen)
}

/**
 * **非结果型**数组字段（元数据）：尝试记录/告警/错误/查询变体等。
 * 它们也是数组，但**不是「结果条数」**——不得被 `resultCount` 当成 Q4 读数。
 * 实证来源（本批单测首跑抓到的真缺陷）：`fetch_robust` 的返回体带 `attempts[]`，
 * 朴素实现「取第一个数组属性」会把「3 次通道尝试」报成「3 条结果」。
 */
export const META_ARRAY_KEYS: readonly string[] = [
  'attempts', 'warnings', 'errors', 'notes', 'queries', 'engines', 'logs', 'trace',
]

/**
 * 结果条数（纯函数，**Q4**）：显式 `count` 优先（= 聚合去重后的条数），
 * 否则取**第一个「非元数据」数组型自有属性**的长度。
 * 脏数据设防（缺陷形状 D4）：非对象/无合法数组 → 0，不抛。
 */
export function resultCount(result: unknown): number {
  if (result === null || typeof result !== 'object') return 0
  const r = result as Record<string, unknown>
  if (typeof r['count'] === 'number' && Number.isFinite(r['count'])) return r['count']
  for (const [key, value] of Object.entries(r)) {
    if (META_ARRAY_KEYS.includes(key)) continue
    if (Array.isArray(value)) return value.length
  }
  return 0
}

/** 成败判定（纯函数，**Q3**）：`ok===false` 或非空 `error` → 失败；否则成功。 */
export function resultOk(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false
  const r = result as Record<string, unknown>
  if (r['ok'] === false) return false
  if (typeof r['error'] === 'string' && r['error'] !== '') return false
  return true
}

/**
 * 反爬通道级别（纯函数，**Q3 关键**）：从结果体里取 `fetchRobust` 的 `channel`。
 * 支持两种形状：结果**自身**带 `channel`，或嵌在 `results[]` 里（如 `fetch_page` 的批量形态）。
 * 取不到 → 空串（**不猜**——该工具没走反爬链就是没走）。
 */
export function channelOf(result: unknown): string {
  if (result === null || typeof result !== 'object') return ''
  const r = result as Record<string, unknown>
  if (typeof r['channel'] === 'string' && r['channel'] !== '') return r['channel']
  for (const value of Object.values(r)) {
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        const c = (item as Record<string, unknown>)['channel']
        if (typeof c === 'string' && c !== '') return c
      }
    }
  }
  return ''
}

/** 反爬通道尝试次数（纯函数，**Q3**）：`attempts` 数组长度；非数组 → 0。 */
export function attemptsOf(result: unknown): number {
  if (result === null || typeof result !== 'object') return 0
  const attempts = (result as Record<string, unknown>)['attempts']
  return Array.isArray(attempts) ? attempts.length : 0
}

/** 单通道读数（`search_web` / `search_deep` 结果里的 `channels[]` 形状）。 */
export interface ChannelDigest {
  engine: string
  ok: boolean
  count: number
  ms?: number
  via?: string
  error?: string
}

/**
 * 通道读数提取（纯函数，**Q3/Q4 的 per-channel 版本**）：只认 `engine` 为非空字符串的项；
 * `count`/`ms` 非有限数设防；`error` 过 `redactText` + 截断 200（**与结果体的脱敏同一红线**）。
 */
export function channelsOf(result: unknown): ChannelDigest[] {
  if (result === null || typeof result !== 'object') return []
  const raw = (result as Record<string, unknown>)['channels']
  if (!Array.isArray(raw)) return []
  const out: ChannelDigest[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const engine = typeof r['engine'] === 'string' ? r['engine'] : ''
    if (engine === '') continue
    const ms = typeof r['ms'] === 'number' && Number.isFinite(r['ms']) ? r['ms'] : undefined
    const via = typeof r['via'] === 'string' && r['via'] !== '' ? r['via'] : undefined
    const error =
      typeof r['error'] === 'string' && r['error'] !== '' ? redactText(truncate(r['error'], 200)) : undefined
    out.push({
      engine: truncate(engine, 40),
      ok: r['ok'] !== false,
      count: typeof r['count'] === 'number' && Number.isFinite(r['count']) ? r['count'] : 0,
      ...(ms !== undefined ? { ms } : {}),
      ...(via !== undefined ? { via } : {}),
      ...(error !== undefined ? { error } : {}),
    })
  }
  return out
}

/** 通道读数 → 一行紧凑文本（trace 的 `channels` 字段）；总量截断（默认 500）。 */
export function formatChannels(list: ChannelDigest[], maxLen = 500): string {
  const text = list
    .map((c) => {
      const head = `${c.engine}=${c.ok ? 'ok' : 'fail'}:${c.count}${c.ms !== undefined ? `@${c.ms}ms` : ''}${c.via ? `/${c.via}` : ''}`
      return c.error ? `${head}(${c.error})` : head
    })
    .join(' ; ')
  return truncate(text, maxLen)
}

/** 失败文案提取（纯函数）：`error` 字段，脱敏 + 截断 500。 */
export function errorOf(result: unknown, thrown?: unknown): string | undefined {
  if (thrown !== null && thrown !== undefined) {
    const msg = thrown instanceof Error ? thrown.message : String(thrown)
    return redactText(truncate('抛错: ' + msg, 500))
  }
  if (result === null || typeof result !== 'object') return undefined
  const error = (result as Record<string, unknown>)['error']
  if (typeof error !== 'string' || error === '') return undefined
  return redactText(truncate(error, 500))
}

/** `composeSearchEntry` 的入参（执行体只填 `args`/返回值，其余由包装器提供）。 */
export interface SearchComposeInput {
  now: number
  phase: SearchTracePhase
  build: string
  op: string
  args: unknown
  durationMs: number
  result?: unknown
  thrown?: unknown
}

/**
 * 轨迹行合成（纯函数，**实现与测试共用的单一真源**）。
 * 隐私保证在此处成立：`params` 走 `paramsDigest`（白名单 + 黑名单 + 脱敏），
 * `error` 走 `errorOf`（脱敏）——**凭据不在合成路径上**。
 */
export function composeSearchEntry(input: SearchComposeInput): SearchTraceEntry {
  const thrown = input.thrown === null || input.thrown === undefined ? null : input.thrown
  const error = errorOf(input.result, thrown === null ? undefined : thrown)
  return {
    atMs: input.now,
    phase: input.phase,
    build: input.build,
    op: input.op,
    params: paramsDigest(input.args),
    count: thrown === null ? resultCount(input.result) : 0,
    channel: channelOf(input.result),
    attempts: attemptsOf(input.result),
    channels: formatChannels(channelsOf(input.result)),
    durationMs: input.durationMs,
    ok: thrown === null && resultOk(input.result),
    ...(error !== undefined ? { error } : {}),
  }
}

/** 稳定序列化（键序固定 + 单行 JSON）。 */
export function serializeTraceEntry(entry: SearchTraceEntry): string {
  const ordered: SearchTraceEntry = {
    atMs: entry.atMs,
    phase: entry.phase,
    build: entry.build,
    op: entry.op,
    params: entry.params,
    count: entry.count,
    channel: entry.channel,
    attempts: entry.attempts,
    channels: entry.channels,
    durationMs: entry.durationMs,
    ok: entry.ok,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  }
  return JSON.stringify(ordered)
}

/** 容错解析：坏行/半行/空行跳过，不抛。 */
export function parseTraceEntries(text: string): SearchTraceEntry[] {
  const out: SearchTraceEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as SearchTraceEntry
      if (typeof parsed.atMs === 'number' && typeof parsed.phase === 'string') out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

/** 读轨迹文件；缺失/不可读返回空数组（诊断工具的安全入口）。 */
export function readTraceEntries(path: string): SearchTraceEntry[] {
  try {
    return parseTraceEntries(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/** 追加一行（失败即吞并返回 false：观测绝不反噬检索）。 */
export function appendTraceEntry(path: string, entry: SearchTraceEntry): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, serializeTraceEntry(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 记一笔检索轨迹（薄接线：路径缺省 `<DSH_HOME>/search-trace.jsonl`）。 */
export function searchTrace(
  entry: SearchTraceEntry,
  opts: { path?: string; home?: string; now?: number } = {},
): boolean {
  const path = opts.path ?? searchTracePath(opts.home ?? resolveHome())
  return appendTraceEntry(path, { ...entry, atMs: opts.now ?? entry.atMs })
}
