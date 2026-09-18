/**
 * SearXNG 就绪门单测（U10 闭环 · 2026-09-18 第二轮）。跑 lib 产物。
 *
 * 覆盖：纯函数（URL 构造 / JSON 解析 / 诊断摘要 / 保活命令 / 尝试文案）
 * + 就绪门四态（直连即就绪 / 命中就绪缓存 / 禁冷启 / 冷启→轮询成功）
 * + **单飞**（并发扇出共享同一次带起，不得重复启 VM）
 * + **有界保活**（ka=0 不得起保活进程）
 * + trace 侧 `channels` 字段（提取 / 格式化 / 合成 / 序列化键序 / 脱敏）。
 *
 * 纪律：**不碰真 VM**——全部走注入 deps（`probe` / `run`），离线可复现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ensureSearxng, resetSearxngState, searxngSearchUrl, parseSearxngResults,
  searxngDiagnostics, keepAliveCmd, formatAttempts, simplifyQuery,
} from '../lib/searxng.js'
import { channelsOf, formatChannels, composeSearchEntry, serializeTraceEntry } from '../lib/trace.js'

const BASE = 'http://127.0.0.1:18788'
const OK_BODY = JSON.stringify({ results: [{ title: 't', url: 'https://example.com/a', content: 'c', engines: ['brave'] }] })

/** 造一份注入 deps：`probes` 按序消费（元素是字符串 body 或 Error）。 */
function makeDeps(probes, calls = []) {
  const queue = [...probes]
  return {
    calls,
    deps: {
      probe: async (url, timeoutMs) => {
        calls.push(`probe:${url.split('?')[0]}:${timeoutMs}`)
        const next = queue.length ? queue.shift() : OK_BODY
        if (next instanceof Error) throw next
        return next
      },
      run: async (args, timeoutMs) => {
        calls.push(`run:${args.join(' ')}:${timeoutMs}`)
        return ''
      },
    },
  }
}

/* ───────── 纯函数 ───────── */

test('searxngSearchUrl: 必须带 format=json（缺它就 403）+ 去尾斜杠 + 编码查询', () => {
  const url = searxngSearchUrl('http://127.0.0.1:18788/', 'a b&c')
  assert.match(url, /^http:\/\/127\.0\.0\.1:18788\/search\?/)
  const qs = new URL(url).searchParams
  assert.equal(qs.get('format'), 'json')
  assert.equal(qs.get('q'), 'a b&c')
  assert.equal(qs.get('safesearch'), '0')
})

test('searxngSearchUrl: categories/language 可选注入', () => {
  const qs = new URL(searxngSearchUrl(BASE, 'x', { categories: 'it', language: 'en' })).searchParams
  assert.equal(qs.get('categories'), 'it')
  assert.equal(qs.get('language'), 'en')
  assert.equal(new URL(searxngSearchUrl(BASE, 'x')).searchParams.get('categories'), null)
})

test('parseSearxngResults: 正常解析（源名带上游引擎）', () => {
  const out = parseSearxngResults(OK_BODY, 5)
  assert.equal(out.length, 1)
  assert.equal(out[0].source, 'searxng:brave')
  assert.equal(out[0].url, 'https://example.com/a')
})

test('parseSearxngResults: 退化输入一律空数组且不抛（HTML/空/坏 JSON/无 url）', () => {
  assert.deepEqual(parseSearxngResults('<html>403 Forbidden</html>', 5), [])
  assert.deepEqual(parseSearxngResults('', 5), [])
  assert.deepEqual(parseSearxngResults('{oops', 5), [])
  assert.deepEqual(parseSearxngResults('{"results":[{"title":"x"}]}', 5), [])
  assert.deepEqual(parseSearxngResults('{"results":null}', 5), [])
})

test('parseSearxngResults: max 上限生效', () => {
  const body = JSON.stringify({ results: Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, url: `https://e.com/${i}` })) })
  assert.equal(parseSearxngResults(body, 3).length, 3)
})

test('searxngDiagnostics: 两种 unresponsive 形状都认', () => {
  const a = searxngDiagnostics(JSON.stringify({ results: [1], unresponsive_engines: [['google', 'timeout'], ['bing', 'x']] }))
  assert.equal(a.count, 1)
  assert.deepEqual(a.unresponsive, ['google', 'bing'])
  const b = searxngDiagnostics(JSON.stringify({ results: [], unresponsive_engines: ['brave'] }))
  assert.deepEqual(b.unresponsive, ['brave'])
  assert.deepEqual(searxngDiagnostics('<html>').unresponsive, [])
})

test('keepAliveCmd: 幂等守卫 + 标记秒数带下界', () => {
  const cmd = keepAliveCmd(120)
  assert.match(cmd, /pgrep -f 'sleep 7200'/)
  assert.match(cmd, /nohup sleep 7200/)
  assert.match(keepAliveCmd(0), /sleep 60/)      // 下界 60s
  assert.match(keepAliveCmd(1), /sleep 60/)
})

test('formatAttempts: 紧凑一行（失败带原因，长原因截断）', () => {
  const s = formatAttempts([
    { step: 'probe-direct', ok: false, ms: 12, error: 'connect ECONNREFUSED' },
    { step: 'boot-vm', ok: true, ms: 900 },
  ])
  assert.equal(s, 'probe-direct=fail(connect ECONNREFUSED);boot-vm=ok')
})

/* ───────── 就绪门四态 ───────── */

test('ensureSearxng: 直连即就绪（只探一次，不碰 wsl）', async () => {
  resetSearxngState()
  const { deps, calls } = makeDeps([OK_BODY])
  const st = await ensureSearxng(BASE, { deps, now: () => 1000 })
  assert.equal(st.ready, true)
  assert.equal(st.via, 'direct')
  assert.equal(st.cached, false)
  assert.deepEqual(st.attempts.map((a) => a.step), ['probe-direct'])
  assert.equal(calls.filter((c) => c.startsWith('run:')).length, 0)
})

test('ensureSearxng: 命中就绪缓存（TTL 内不再探活）', async () => {
  resetSearxngState()
  let clock = 1000
  const { deps, calls } = makeDeps([OK_BODY, OK_BODY])
  await ensureSearxng(BASE, { deps, now: () => clock })
  clock += 30_000
  const st = await ensureSearxng(BASE, { deps, now: () => clock })
  assert.equal(st.cached, true)
  assert.equal(st.attempts.length, 0)
  assert.equal(calls.filter((c) => c.startsWith('probe:')).length, 1) // 只探过一次
})

test('ensureSearxng: TTL 过期后重新探活', async () => {
  resetSearxngState()
  let clock = 1000
  const { deps, calls } = makeDeps([OK_BODY, OK_BODY])
  await ensureSearxng(BASE, { deps, now: () => clock, ttlMs: 1000 })
  clock += 5_000
  const st = await ensureSearxng(BASE, { deps, now: () => clock, ttlMs: 1000 })
  assert.equal(st.cached, false)
  assert.equal(calls.filter((c) => c.startsWith('probe:')).length, 2)
  assert.equal(st.attempts[0].step, 'probe-direct')
})

test('ensureSearxng: allowBoot=false 时两条探活都失败即判未就绪（不启 VM）', async () => {
  resetSearxngState()
  const { deps, calls } = makeDeps([new Error('connect ECONNREFUSED 127.0.0.1:18788'), new Error('curl: (7) Failed to connect')])
  const st = await ensureSearxng(BASE, { deps, allowBoot: false, now: () => 1000 })
  assert.equal(st.ready, false)
  assert.equal(st.via, 'none')
  assert.deepEqual(st.attempts.map((a) => `${a.step}:${a.ok}`), ['probe-direct:false', 'probe-wsl:false'])
  assert.equal(calls.filter((c) => c.startsWith('run:')).length, 0)
})

test('ensureSearxng: 直连不通但 WSL 内 curl 通 ⇒ via=wsl（宿主实际走的那条路）', async () => {
  resetSearxngState()
  const calls = []
  const st = await ensureSearxng(BASE, {
    now: () => 1000,
    deps: {
      probe: async () => { calls.push('direct'); throw new Error('emit ECONNREFUSED') },
      probeWsl: async () => { calls.push('wsl'); return '{"results":[]}' },
      run: async () => '',
    },
  })
  assert.equal(st.ready, true)
  assert.equal(st.via, 'wsl')
  assert.deepEqual(calls, ['direct', 'wsl'])
  assert.deepEqual(st.attempts.map((a) => a.step), ['probe-direct', 'probe-wsl'])
})

test('ensureSearxng: 冷启路径 = 两探活失败 → boot-vm → container-health → 轮询成功 → 保活', async () => {
  resetSearxngState()
  let clock = 1000
  // 探活队列：direct fail、wsl fail、之后 wsl 命中的 body（空 results 也算服务在答）
  const calls = []
  const { deps } = makeDeps([new Error('ECONNREFUSED')], calls)
  const st = await ensureSearxng(BASE, {
    deps: {
      ...deps,
      probeWsl: async (url, timeoutMs) => {
        calls.push(`probeWsl:${timeoutMs}`)
        const n = calls.filter((c) => c.startsWith('probeWsl:')).length
        if (n === 1) throw new Error('curl: (7) Failed to connect')
        return OK_BODY
      },
    },
    now: () => { clock += 800; return clock },
    timeoutMs: 20_000,
    keepAliveMinutes: 120,
  })
  assert.equal(st.ready, true)
  assert.equal(st.via, 'wsl')
  const steps = st.attempts.map((a) => a.step)
  assert.deepEqual(steps.slice(0, 4), ['probe-direct', 'probe-wsl', 'boot-vm', 'container-health'])
  assert.equal(st.attempts[0].ok, false)
  assert.ok(calls.some((c) => c.includes('-- true')), '应冷启 VM')
  await new Promise((r) => setTimeout(r, 20)) // keep-alive 是 fire-and-forget，让它落一拍
  assert.ok(calls.some((c) => c.includes('pgrep')), '保活命令应已下发')
})

test('ensureSearxng: 容器处于 Restarting ⇒ container-health 走自愈 down/up（不碰 --force-recreate）', async () => {
  resetSearxngState()
  const calls = []
  let clock = 1000
  const st = await ensureSearxng(BASE, {
    now: () => { clock += 300; return clock },
    timeoutMs: 6_000,
    keepAliveMinutes: 0,
    deps: {
      probe: async () => { throw new Error('ECONNREFUSED') },
      probeWsl: (() => { let n = 0; return async () => { n++; if (n <= 2) throw new Error('curl: (7) Failed to connect'); return '{"results":[]}' } })(),
      run: async (args) => {
        const cmd = args.join(' ')
        calls.push(cmd)
        if (cmd.includes('--format')) return 'Restarting (1) 2 seconds ago'   // 容器在 crash-loop
        return ''
      },
    },
  })
  assert.equal(st.ready, true)
  const compose = calls.find((c) => c.includes('docker compose'))
  assert.ok(compose, '应触发自愈')
  assert.match(compose, /down --remove-orphans/)
  assert.match(compose, /up -d/)
  assert.ok(!calls.some((c) => c.includes('--force-recreate')), '不得用 --force-recreate（上一轮实测留端口僵尸）')
})

test('ensureSearxng: 容器 Up ⇒ 不自愈（不无谓重启）', async () => {
  resetSearxngState()
  const calls = []
  await ensureSearxng(BASE, {
    now: () => 1000,
    timeoutMs: 6_000,
    deps: {
      probe: async () => { throw new Error('ECONNREFUSED') },
      probeWsl: (() => { let n = 0; return async () => { n++; if (n <= 2) throw new Error('curl: (7) Failed to connect'); return '{"results":[]}' } })(),
      run: async (args) => {
        const cmd = args.join(' ')
        calls.push(cmd)
        if (cmd.includes('--format')) return 'Up 3 seconds'
        return ''
      },
    },
  })
  assert.ok(!calls.some((c) => c.includes('docker compose')), 'Up 状态不该触发 compose')
})

test('ensureSearxng: keepAliveMinutes=0 ⇒ 不得起保活进程', async () => {
  resetSearxngState()
  let clock = 1000
  const { deps, calls } = makeDeps([new Error('ECONNREFUSED'), OK_BODY])
  await ensureSearxng(BASE, { deps, now: () => { clock += 800; return clock }, keepAliveMinutes: 0 })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(calls.filter((c) => c.includes('pgrep')).length, 0)
})

test('ensureSearxng: 预算耗尽 ⇒ ready=false（attempts 里有 poll 失败，不静默）', async () => {
  resetSearxngState()
  // 时钟前 14 次调用停在 1000（让流程走到轮询），之后跳到远处 ⇒ 预算一次就耗尽。
  let n = 0
  const now = () => (n++ < 14 ? 1000 : 1_000_000)
  const { deps } = makeDeps(Array.from({ length: 8 }, () => new Error('ECONNREFUSED')))
  const st = await ensureSearxng(BASE, { deps, now, timeoutMs: 3_000 })
  assert.equal(st.ready, false)
  assert.equal(st.via, 'none')
  assert.ok(st.attempts.filter((a) => a.step === 'poll-wsl').length >= 1, '应至少轮询过一次')
  assert.ok(st.attempts.some((a) => a.error !== undefined), '失败必须带原因（不静默）')
})

test('ensureSearxng: 单飞——并发调用只带起一次（boot-vm 只跑一次）', async () => {
  resetSearxngState()
  let clock = 1000
  const calls = []
  let wslProbe = 0
  const deps = {
    probe: async () => { calls.push('direct'); throw new Error('ECONNREFUSED') },
    probeWsl: async () => {
      wslProbe++
      calls.push(`wsl:${wslProbe}`)
      if (wslProbe === 1) throw new Error('curl: (7) Failed to connect')
      return OK_BODY
    },
    run: async (args) => {
      const cmd = args.join(' ')
      calls.push(cmd.includes('--format') ? 'status' : 'run')
      return cmd.includes('--format') ? 'Up 1 second' : ''
    },
  }
  const opts = { deps, now: () => { clock += 800; return clock }, timeoutMs: 20_000, keepAliveMinutes: 0 }
  const [a, b] = await Promise.all([ensureSearxng(BASE, opts), ensureSearxng(BASE, opts)])
  assert.equal(a.ready, true)
  assert.equal(b.ready, true)
  assert.equal(calls.filter((c) => c === 'run').length, 1, 'boot-vm 只能跑一次（单飞）')
  assert.equal(calls.filter((c) => c === 'status').length, 1, 'container-health 也只能一次')
})

/* ───────── trace 侧 channels ───────── */

test('channelsOf: 提取 + 设防（缺 engine 丢；count/ms 非有限数归 0/丢；error 脱敏截断）', () => {
  const out = channelsOf({
    channels: [
      { engine: 'searxng', ok: false, count: 0, ms: 12.5, via: 'none', error: 'api_key=sk-abcdefghijklmnopqrstuvwxyz012345' },
      { engine: '', ok: true, count: 3 },
      { engine: 'parallel', ok: true, count: Number.POSITIVE_INFINITY, ms: Number.NaN },
      'junk',
      null,
    ],
  })
  assert.equal(out.length, 2)
  assert.equal(out[0].engine, 'searxng')
  assert.match(out[0].error, /\[redacted\]/)
  assert.equal(out[1].engine, 'parallel')
  assert.equal(out[1].count, 0)
  assert.equal(out[1].ms, undefined)
  assert.deepEqual(channelsOf(null), [])
  assert.deepEqual(channelsOf({}), [])
})

test('formatChannels: 紧凑文本（含 via / error），超长截断', () => {
  const s = formatChannels([{ engine: 'searxng', ok: false, count: 0, ms: 9000, via: 'none', error: '就绪门未通过' }])
  assert.equal(s, 'searxng=fail:0@9000ms/none(就绪门未通过)')
  const long = formatChannels([{ engine: 'x', ok: true, count: 1, error: 'y'.repeat(300) }], 60)
  assert.ok(long.length <= 61)
})

test('composeSearchEntry + serializeTraceEntry: channels 字段在固定的键位上', () => {
  const entry = composeSearchEntry({
    now: 111, phase: 'call', build: 'v@1', op: 'search_web', args: { query: 'q' }, durationMs: 5,
    result: { ok: true, count: 2, channels: [{ engine: 'searxng', ok: true, count: 2, ms: 30, via: 'direct' }] },
  })
  assert.equal(entry.channels, 'searxng=ok:2@30ms/direct')
  const keys = Object.keys(JSON.parse(serializeTraceEntry(entry)))
  assert.deepEqual(keys, ['atMs', 'phase', 'build', 'op', 'params', 'count', 'channel', 'attempts', 'channels', 'durationMs', 'ok'])
})

test('composeSearchEntry: 无 channels 的工具 ⇒ 空串（不猜、不编）', () => {
  const entry = composeSearchEntry({ now: 1, phase: 'call', build: 'v@1', op: 'lookup_whois', args: {}, durationMs: 1, result: { ok: true, count: 1 } })
  assert.equal(entry.channels, '')
})

test('simplifyQuery: 长查询取前 4 词并剥标点；短查询/退化输入返回空串（跳过第二发）', () => {
  assert.equal(simplifyQuery('wsl docker container lifecycle internals explained'), 'wsl docker container lifecycle')
  assert.equal(simplifyQuery('"sqlite wal mode" checkpoint? tuning'), 'sqlite wal mode checkpoint')
  assert.equal(simplifyQuery('sqlite wal mode checkpoint'), '')
  assert.equal(simplifyQuery('two words only'), '')
  assert.equal(simplifyQuery(''), '')
  assert.equal(simplifyQuery(undefined), '')
  assert.equal(simplifyQuery('一 二 三 四'), '')
})
