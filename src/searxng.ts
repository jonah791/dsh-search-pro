/**
 * SearXNG 通道就绪门（U10 闭环 · 2026-09-18 第二轮迭代）。
 *
 * **事故形状**：自托管 SearXNG 跑在 WSL 的 Docker 里，而宿主 web 进程在 Windows。
 * 上一轮的判词是「Windows↔WSL 可达性间歇」——**不准**。13:45 实测定性：
 * `.wslconfig` 没写 `vmIdleTimeout` ⇒ WSL VM 空闲约 60 s 后**整台关机**（容器随之消失），
 * 同一轮里两次 `wsl` 调用之间就能观察到 `VM boot 13:43:29` → `dockerd: Daemon has completed
 * initialization 13:45:04`、容器 `RestartCount=0` 重建。而 `.wslconfig` 是 `networkingMode=mirrored`
 * ——WSL 内 `127.0.0.1:8888` 本应经**共享回环**直达 Windows（「偶发走通」＝恰好 VM 还活着，
 * `000` ＝VM 已关机）。⇒ **改端口映射解决不了主因**（VM 关了就是没人监听）。
 *
 * **本模块的修法**：把「带起通道」变成一次显式的、可观测的准备动作——
 *   探活（direct）→ 冷启 VM（`wsl.exe … true`）→ 幂等确保容器在跑（`docker start`）→ 轮询到就绪；
 *   成功后（a）**就绪缓存**（TTL 内不再重复探活）、（b）单飞（并发扇出共享同一次带起）、
 *   （c）可选**有界保活**（一个 `sleep` 进程把 VM 钉住，搜索会话期间不被空闲回收）。
 *
 * **观测**：每一步都进 `attempts`（step/ok/ms/error 原文），由上层汇进 `search-trace.jsonl`
 * 的 per-channel 字段——「通道 0 条」从此能读出**断在哪一段**（技能 plugin-maintainability 五问 Q3）。
 *
 * @module dsh-search-pro/searxng
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { httpGet, normalizeUrl, sleep } from './util.js'

const execFileAsync = promisify(execFile)

/** 单步尝试记录（Q3 读数：断在哪一段）。 */
export interface SxAttempt {
  step: string
  ok: boolean
  ms: number
  error?: string
}

/** SearXNG JSON 结果（本模块自有形状，避免与 engines.ts 循环依赖）。 */
export interface SxResult {
  title: string
  url: string
  snippet: string
  source: string
}

/** 就绪门结论。 */
export interface EnsureState {
  ready: boolean
  /** `direct`＝Windows 侧直连通；`wsl`＝WSL 内 curl 通（宿主实际走的那条）；`none`＝都带不起来。 */
  via: 'direct' | 'wsl' | 'none'
  ms: number
  attempts: SxAttempt[]
  /** true＝命中就绪缓存（没花探活成本）。 */
  cached: boolean
}

export interface SxDeps {
  /** 探活（Windows 侧直连）：成功返回 body，失败抛错。 */
  probe: (url: string, timeoutMs: number) => Promise<string>
  /** 探活（**WSL 内 curl**）：这是宿主实际可用的那条路（2026-09-18 14:45 实测：
   *  Windows 直连 000，WSL 内 curl 200/35 条）——直连失败时由它定论。 */
  probeWsl: (url: string, timeoutMs: number) => Promise<string>
  /** 跑一条 `wsl.exe` 命令（argv 直传，不经 shell）。 */
  run: (args: string[], timeoutMs: number) => Promise<string>
  log?: (a: SxAttempt) => void
}

export interface EnsureOpts {
  /** 就绪等待总预算（ms，默认 15000）。 */
  timeoutMs?: number
  /** 单次探活超时（ms，默认 3000）。 */
  probeTimeoutMs?: number
  /** 就绪缓存时长（ms，默认 120000）——刚验过的实例不必反复探。 */
  ttlMs?: number
  /** 允许冷启 VM（默认 true；false＝只探活，带不起来就算没就绪）。 */
  allowBoot?: boolean
  /** 冷启成功后留一个保活进程（分钟；默认 120，0＝不留）。 */
  keepAliveMinutes?: number
  deps?: Partial<SxDeps>
  now?: () => number
  /** 探活用的查询词（默认固定哨兵词，纯就绪语义）。 */
  probeQuery?: string
}

/** 默认探活实现（Windows 侧直连）。 */
async function defaultProbe(url: string, timeoutMs: number): Promise<string> {
  return httpGet(url, { timeoutMs })
}

/** 默认 WSL 内探活（`curl --noproxy '*'`）——**这条才是实测可用的路**：
 *  Windows 直连 000、WSL 内 curl 200（2026-09-18 14:45 实测，35 条结果）。
 *  剥代理 env + `--noproxy '*'`：宿主继承的 `HTTP(S)_PROXY` 会把本机请求送去 Clash（实测 502）。 */
async function defaultProbeWsl(url: string, timeoutMs: number): Promise<string> {
  const safe = url.replace(/'/g, '%27')
  const secs = Math.max(3, Math.ceil(timeoutMs / 1000))
  const cmd =
    `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy ` +
    `curl -s --noproxy '*' -m ${secs} '${safe}'`
  return wslRun(['-d', 'Ubuntu', '--', 'bash', '-lc', cmd], timeoutMs + 6000)
}

/** `wsl.exe` 执行器（argv 直传；`--` 之后是 distro 内的命令）。
 *  导出给同插件的其它模块复用——**不要出现第二份 spawn 逻辑**（通道纪律要一处收口）。 */
export async function wslRun(args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync('wsl.exe', args, {
    timeout: timeoutMs + 2000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

/** 就绪缓存（单实例，键＝base URL）。 */
let readyCache: { base: string; atMs: number } | null = null
/** 单飞：并发扇出共享同一次带起（3 条 searxng 查询不该各启一次 VM）。 */
let inflight: Promise<EnsureState> | null = null

/** 测试与诊断用：清掉就绪缓存 / 单飞状态。 */
export function resetSearxngState(): void {
  readyCache = null
  inflight = null
}

/** 构造 SearXNG JSON 查询 URL（纯函数）。 */
export function searxngSearchUrl(
  base: string,
  query: string,
  opts: { categories?: string; language?: string } = {},
): string {
  const root = String(base).replace(/\/+$/, '')
  const qs = new URLSearchParams({ q: query, format: 'json', safesearch: '0' })
  if (opts.categories) qs.set('categories', opts.categories)
  if (opts.language) qs.set('language', opts.language)
  return `${root}/search?${qs.toString()}`
}

/**
 * 解析 SearXNG JSON（纯函数，**永不抛**）：`results[]` → 统一结果形状。
 * 空体 / HTML（403 页）/ 半个 JSON 一律按「本通道无结果」返回 `[]`——
 * 由上层「通道贡献」行如实报 0，而不是伪装成成功。
 */
export function parseSearxngResults(raw: string, max = 10): SxResult[] {
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  const results = Array.isArray(data?.results) ? data.results : []
  const out: SxResult[] = []
  for (const r of results) {
    const url = normalizeUrl(String(r?.url ?? ''))
    if (!url) continue
    const engines = Array.isArray(r?.engines) ? r.engines.map((e: unknown) => String(e)) : []
    out.push({
      title: String(r?.title ?? '') || url,
      url,
      snippet: String(r?.content ?? '').replace(/\s+/g, ' ').slice(0, 400),
      source: engines.length ? `searxng:${engines.join('+')}` : 'searxng',
    })
    if (out.length >= max) break
  }
  return out
}

/**
 * 诊断摘要（纯函数）：条数 + 本轮**没响应**的引擎名。
 * 用途：searxng 返回 0 条时，错误文案要能说出「是它自己空手」还是「上游引擎全挂了」。
 */
export function searxngDiagnostics(raw: string): { count: number; unresponsive: string[] } {
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    return { count: 0, unresponsive: [] }
  }
  const results = Array.isArray(data?.results) ? data.results : []
  const un = data?.unresponsive_engines
  const unresponsive = Array.isArray(un)
    ? un.map((e: unknown) => (Array.isArray(e) ? String(e[0]) : String(e)))
    : []
  return { count: results.length, unresponsive }
}

/**
 * 保活命令（纯函数）：**幂等**——已有同标记进程就不再起第二个。
 * 用一个不常见的秒数当标记，避免与别的 `sleep` 撞车；`nohup … &` 让 wsl.exe 立刻退出而进程留在 distro 里。
 */
export function keepAliveCmd(minutes: number): string {
  const secs = Math.max(60, Math.round(minutes * 60))
  const marker = `sleep ${secs}`
  return `pgrep -f '${marker}' >/dev/null 2>&1 || (nohup ${marker} >/dev/null 2>&1 &) ; echo ok`
}

/**
 * 查询简化（纯函数，**空手时的第二发**）：长查询在上游引擎眼里更难命中、也更容易撞限流。
 * 取前 4 个词并剥掉标点噪音；若简化后与原串相同/过短则返回空串（调用方据此跳过第二次尝试）。
 */
export function simplifyQuery(query: string): string {
  const base = String(query ?? '').trim()
  if (!base) return ''
  const words = base.replace(/["'`?？！!。，,、：:；;()（）]+/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length <= 4) return ''
  const short = words.slice(0, 4).join(' ')
  return short === base ? '' : short
}

function readyCached(base: string, nowMs: number, ttlMs: number): boolean {
  return readyCache !== null && readyCache.base === base && nowMs - readyCache.atMs < ttlMs
}

/**
 * 就绪门：把 SearXNG 通道**带起来**再交给查询。
 *
 * 返回 `ready=false` 时不要吞掉——上层应把它写进通道贡献 / trace 的错误字段（观测面纪律）。
 */
export async function ensureSearxng(base: string, opts: EnsureOpts = {}): Promise<EnsureState> {
  const now = opts.now ?? (() => Date.now())
  const ttlMs = opts.ttlMs ?? 120_000
  if (readyCached(base, now(), ttlMs)) {
    return { ready: true, via: 'direct', ms: 0, attempts: [], cached: true }
  }
  if (inflight) return inflight
  const p = doEnsure(base, opts).finally(() => {
    inflight = null
  })
  inflight = p
  return p
}

async function doEnsure(base: string, opts: EnsureOpts): Promise<EnsureState> {
  const now = opts.now ?? (() => Date.now())
  const t0 = now()
  const attempts: SxAttempt[] = []
  const deps: SxDeps = {
    probe: opts.deps?.probe ?? defaultProbe,
    // 注入 deps 时（单测）第二条探活回落成第一条，保持**离线可复现**；生产路径才用真 wsl。
    probeWsl: opts.deps?.probeWsl ?? opts.deps?.probe ?? defaultProbeWsl,
    run: opts.deps?.run ?? wslRun,
    ...(opts.deps?.log ? { log: opts.deps.log } : {}),
  }
  const step = async (name: string, fn: () => Promise<boolean>): Promise<boolean> => {
    const s = now()
    let ok = false
    let error: string | undefined
    try {
      ok = await fn()
    } catch (e: any) {
      error = String(e?.message ?? e)
    }
    const a: SxAttempt = { step: name, ok, ms: now() - s, ...(error !== undefined ? { error } : {}) }
    attempts.push(a)
    deps.log?.(a)
    return ok
  }

  const probeUrl = searxngSearchUrl(base, opts.probeQuery ?? 'alice-readiness-ping')
  const directOk = () => async () => (await deps.probe(probeUrl, opts.probeTimeoutMs ?? 3000)).length > 0
  const wslOk = () => async () =>
    (await deps.probeWsl(probeUrl, Math.max(3000, opts.probeTimeoutMs ?? 3000))).includes('"results"')

  // ① Windows 侧直连（便宜；通了就最快）
  if (await step('probe-direct', directOk())) {
    readyCache = { base, atMs: now() }
    return { ready: true, via: 'direct', ms: now() - t0, attempts, cached: false }
  }
  // ② WSL 内 curl ——**宿主实际可用的那条路**（直连失败不影响就绪判定）
  if (await step('probe-wsl', wslOk())) {
    readyCache = { base, atMs: now() }
    return { ready: true, via: 'wsl', ms: now() - t0, attempts, cached: false }
  }
  if (opts.allowBoot === false) {
    return { ready: false, via: 'none', ms: now() - t0, attempts, cached: false }
  }

  // ③ 冷启 VM：任何一次 wsl.exe 活动都会把 distro 拉起来（VM 关机的唯一原因就是空闲）
  await step('boot-vm', async () => {
    await deps.run(['-d', 'Ubuntu', '--', 'true'], 30_000)
    return true
  })
  // ④ 容器健康：**Restarting/Exited 就自愈**（`Address already in use` 那次事故：容器 crash-loop，
  //    门却只会 `docker start` 一个已经在重启的容器 ⇒ 永远起不来。自愈用文档化的 down/up 组合，
  //    不用 `--force-recreate`——上一轮实测它留端口僵尸）。
  await step('container-health', async () => {
    const ps = await deps.run(
      ['-d', 'Ubuntu', '--', 'bash', '-lc', "docker ps --filter name=alice-searxng --format '{{.Status}}'"],
      30_000,
    )
    const status = ps.trim()
    if (status.startsWith('Up')) return true
    await deps.run(
      ['-d', 'Ubuntu', '--', 'bash', '-lc',
        'cd /mnt/e/alice/.tools/searxng && docker compose down --remove-orphans >/dev/null 2>&1; docker compose up -d >/dev/null 2>&1 || true'],
      60_000,
    )
    return true
  })

  // ⑤ 轮询到就绪（预算内）
  const deadline = t0 + (opts.timeoutMs ?? 15_000)
  let ready = false
  while (now() < deadline) {
    if (await step('poll-wsl', wslOk())) {
      ready = true
      break
    }
    await sleep(700)
  }

  if (ready) {
    readyCache = { base, atMs: now() }
    const ka = opts.keepAliveMinutes ?? 120
    if (ka > 0) {
      // 有界保活：钉住 VM，避免搜索会话中途被空闲回收（失败只记一步，不影响本次查询）
      void step('keep-alive', async () => {
        await deps.run(['-d', 'Ubuntu', '--', 'bash', '-lc', keepAliveCmd(ka)], 20_000)
        return true
      })
    }
  }
  return { ready, via: ready ? 'wsl' : 'none', ms: now() - t0, attempts, cached: false }
}

/** 一步尝试的紧凑文案（trace / 错误字段用）。 */
export function formatAttempts(attempts: SxAttempt[]): string {
  return attempts
    .map((a) => `${a.step}=${a.ok ? 'ok' : 'fail'}${a.error ? `(${a.error.slice(0, 120)})` : ''}`)
    .join(';')
}
