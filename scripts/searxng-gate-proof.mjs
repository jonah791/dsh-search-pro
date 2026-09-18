/**
 * SearXNG 通道就绪门取证（**Windows 侧跑**，与宿主 web 进程同侧语义）。
 *
 * 用途：U10 的可复现验收——「Windows 侧直连 searxng **连续 3 次**真拿到结果」。
 * 关键设计：① 轮与轮之间**故意静默若干秒**（`> WSL VM 默认空闲回收窗 ~60 s` 时能验保活）；
 * ② **每轮换一个查询**——同一查询连打会把上游引擎打到限流（实测 `brave: Suspended: too many requests`、
 * `duckduckgo: CAPTCHA`）。那是**上游限流**，不是通道坏了；验收必须用真实使用形态（查询是变的）。
 *
 * 用法：`node scripts/searxng-gate-proof.mjs [轮数] [静默秒数]`
 */
import { ensureSearxng, resetSearxngState } from '../lib/searxng.js'
import { searchSearxng } from '../lib/engines.js'

const rounds = Math.max(1, Math.min(5, Number(process.argv[2] ?? 3)))
const idleSec = Math.max(0, Math.min(180, Number(process.argv[3] ?? 75)))
const base = process.env['SEARXNG_BASE'] ?? 'http://127.0.0.1:18788'
const QUERIES = [
  'wsl docker container lifecycle',
  'python asyncio task group best practices',
  'sqlite wal mode checkpoint semantics',
  'searxng engine rate limits and suspension',
]
const queryFor = (i) => QUERIES[(i - 1) % QUERIES.length]

resetSearxngState()

for (let i = 1; i <= rounds; i++) {
  const t0 = Date.now()
  const state = await ensureSearxng(base, { timeoutMs: 20_000, keepAliveMinutes: 120 })
  const results = await searchSearxng(queryFor(i), base, 5, { readyTimeoutMs: 20_000 })
  const line = {
    round: i,
    query: queryFor(i),
    ready: state.ready,
    via: state.via,
    cached: state.cached,
    gateMs: state.ms,
    bootedVm: state.attempts.some((a) => a.step === 'boot-vm'),
    steps: state.attempts.map((a) => `${a.step}:${a.ok ? 'ok' : 'fail'}:${a.ms}ms${a.error ? `(${a.error.slice(0, 100)})` : ''}`),
    results: results.length,
    sample: results[0]?.url ?? '',
    totalMs: Date.now() - t0,
  }
  console.log(JSON.stringify(line))
  if (i < rounds && idleSec > 0) await new Promise((r) => setTimeout(r, idleSec * 1000))
}
