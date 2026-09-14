/**
 * 检索面轨迹单测（跑 lib 产物，不拉 cordis 依赖树）。
 *
 * 覆盖：纯函数（路径 / 截断 / 脱敏 / **参数摘要白名单** / 结果条数 / 成败判定 / **反爬通道级别** /
 * 尝试次数 / 错误提取 / **轨迹行合成 composeSearchEntry** / 序列化 / 解析）
 * + 真实落盘与回读 + 退化路径（脏数据/坏行/半行/空文件/缺失文件/目录误当文件）
 * + **尸体测试**（父路径是普通文件 → false 且不抛）
 * + **隐私尸体测试端到端**（`search_leaks` 的 `password`、`apiKey`/`token` 参数、error 里的 Bearer → 落盘行搜不到）
 * + 一条离线组合（复刻三类工具调用 → 轨迹行一次答出五问）。
 *
 * 说明：包装器 `tracedExecute` 是 `apply` 内闭包（依赖 cordis ctx），不可离线调用；
 * 故本测试直接驱动它调用的**同一**合成函数 `composeSearchEntry`——实现与测试共用单一真源。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SECRET_KEY_RE,
  SUBJECT_KEYS,
  appendTraceEntry,
  attemptsOf,
  buildStamp,
  channelOf,
  composeSearchEntry,
  errorOf,
  mtimeOf,
  paramsDigest,
  parseTraceEntries,
  readPackageVersion,
  readTraceEntries,
  redactText,
  resolveHome,
  resultCount,
  resultOk,
  searchTrace,
  searchTracePath,
  serializeTraceEntry,
  truncate,
  valueDigest,
} from '../lib/trace.js'

const tmp = mkdtempSync(join(tmpdir(), 'search-trace-test-'))
const base = (entry) => ({
  atMs: 1_700_000_000_000,
  phase: 'call',
  build: '0.1.0@123',
  op: 'search_web',
  params: 'query=爱丽丝',
  count: 12,
  channel: '',
  attempts: 0,
  durationMs: 4200,
  ok: true,
  ...entry,
})

test('resolveHome：DSH_HOME 优先，空白/缺失回退 <homedir>/.dsh', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }, '/home/x'), 'E:/alice/.dsh')
  assert.equal(resolveHome({ DSH_HOME: '  ' }, '/home/x'), join('/home/x', '.dsh'))
  assert.equal(resolveHome({}, '/home/x'), join('/home/x', '.dsh'))
})

test('searchTracePath：锚定 DSH_HOME 下的单一文件名', () => {
  assert.equal(searchTracePath('/h/.dsh'), join('/h', '.dsh', 'search-trace.jsonl'))
})

test('truncate / redactText / valueDigest：边界与脱敏（普通检索词不误伤）', () => {
  assert.equal(truncate('abc', 5), 'abc')
  assert.equal(truncate('abcdef', 3), 'abc…')
  assert.equal(redactText('Bearer sk-live-abcdefgh'), 'Bearer [redacted]')
  assert.equal(redactText('api_key=hunter2secret'), 'api_key=[redacted]')
  assert.equal(redactText('爱丽丝 插件可维护性'), '爱丽丝 插件可维护性')
  assert.equal(valueDigest(['duckduckgo', 'brave']), 'duckduckgo|brave')
  assert.equal(valueDigest(null), 'null')
  assert.equal(valueDigest({ a: 1 }), '{…}')
  assert.equal(valueDigest(7), '7')
})

test('paramsDigest：白名单键才记 / 敏感键名整键丢弃 / 键序稳定 / 空参为空串', () => {
  assert.equal(
    paramsDigest({ query: '爱丽丝', site: 'github.com', engines: ['duckduckgo', 'brave'], pages: 2 }),
    'query=爱丽丝;site=github.com;engines=duckduckgo|brave',
  )
  // 不在白名单的键（pages）不记 —— 白名单是**正面清单**，不是黑名单
  assert.equal(paramsDigest({ pages: 2, unrelated: 'x' }), '')
  // 键序按白名单序（与传入顺序无关）→ 轨迹行可稳定 diff
  assert.equal(paramsDigest({ site: 'a.com', query: 'b' }), paramsDigest({ query: 'b', site: 'a.com' }))
  // 空串与 undefined 跳过
  assert.equal(paramsDigest({ query: '', url: undefined }), '')
  assert.equal(paramsDigest(null), '')
  assert.equal(paramsDigest('str'), '')
  assert.equal(paramsDigest({}), '')
  // 值里的凭据被脱敏
  assert.match(paramsDigest({ url: 'https://x/y/api_key=hunter2secret' }), /\[redacted\]/)
  // 总量截断
  assert.ok(paramsDigest({ query: 'q'.repeat(500) }, 50).length <= 51)
})

test('隐私红线①：敏感键名即使进了白名单也整键丢弃（双保险）', () => {
  // search_leaks 的 password：既不在 SUBJECT_KEYS，也命中 SECRET_KEY_RE
  assert.equal(SUBJECT_KEYS.includes('password'), false)
  assert.ok(SECRET_KEY_RE.test('password'))
  assert.ok(SECRET_KEY_RE.test('apiKey'))
  assert.ok(SECRET_KEY_RE.test('token'))
  assert.ok(SECRET_KEY_RE.test('credentialsFile'))
  assert.ok(SECRET_KEY_RE.test('Cookie'))
  assert.equal(SECRET_KEY_RE.test('query'), false)
  assert.equal(paramsDigest({ password: 'hunter2secret' }), '')
  // 白名单里若有人日后加了敏感名，第二道闸仍然拦住
  const wouldBeWhitelisted = { sessionId: 'abc', apiKey: 'sk-live-abcdefgh' }
  assert.equal(paramsDigest(wouldBeWhitelisted), '')
})

test('resultCount：显式 count 优先（= 聚合去重后条数），否则第一个**非元数据**数组；脏数据不抛', () => {
  assert.equal(resultCount({ ok: true, count: 12, results: new Array(99) }), 12)
  assert.equal(resultCount({ ok: true, results: [1, 2, 3] }), 3)
  assert.equal(resultCount({ files: ['a', 'b'] }), 2)
  assert.equal(resultCount({ count: 0, results: [1] }), 0)
  assert.equal(resultCount({ ok: true }), 0)
  assert.equal(resultCount(null), 0)
  assert.equal(resultCount(undefined), 0)
  assert.equal(resultCount('x'), 0)
  assert.equal(resultCount({ count: Number.NaN, results: [1, 2] }), 2)  // NaN 不算合法 count
  assert.equal(resultCount({ results: null, count: 3 }), 3)
  // **缺陷回归（本批单测首跑抓到）**：元数据数组不得当结果条数。
  // 实证样本 = fetch_robust 的返回体：带 attempts[]（3 次通道尝试）却没有 results。
  assert.equal(
    resultCount({ ok: true, channel: 'headless', attempts: [{ channel: 'a' }, { channel: 'b' }, { channel: 'c' }] }),
    0,
    'attempts 是通道尝试记录，不是结果条数',
  )
  assert.equal(resultCount({ warnings: ['w1', 'w2'], results: [1] }), 1)   // 跳过元数据后仍能取到真结果
  assert.equal(resultCount({ queries: ['q1', 'q2', 'q3'] }), 0)
})

test('resultOk：ok===false 或非空 error 判失败；其余判成功；非对象判失败', () => {
  assert.equal(resultOk({ ok: true }), true)
  assert.equal(resultOk({ ok: false, error: 'boom' }), false)
  assert.equal(resultOk({ error: 'boom' }), false)
  assert.equal(resultOk({ error: '' }), true)
  assert.equal(resultOk({ rows: [] }), true)
  assert.equal(resultOk(null), false)
  assert.equal(resultOk(undefined), false)
  assert.equal(resultOk('x'), false)
})

test('channelOf / attemptsOf：反爬通道链走到哪一级（直取 + 嵌在 results[] 两级）', () => {
  assert.equal(channelOf({ channel: 'headless' }), 'headless')
  assert.equal(channelOf({ ok: true, channel: 'fingerprint', attempts: [1, 2] }), 'fingerprint')
  assert.equal(channelOf({ results: [{ channel: 'prewarm' }] }), 'prewarm')
  assert.equal(channelOf({ results: [{ channel: '' }, { channel: 'retry' }] }), 'retry')
  // 取不到就空串——不猜（该工具没走反爬链就是没走）
  assert.equal(channelOf({ ok: true }), '')
  assert.equal(channelOf(null), '')
  assert.equal(channelOf('x'), '')
  assert.equal(attemptsOf({ attempts: [{ channel: 'a' }, { channel: 'b' }] }), 2)
  assert.equal(attemptsOf({ attempts: 'nope' }), 0)
  assert.equal(attemptsOf(null), 0)
})

test('errorOf：抛错优先 / 结果 error / 无错 / 脱敏截断', () => {
  assert.match(errorOf(undefined, new Error('kaboom')), /^抛错: kaboom/)
  assert.equal(errorOf({ error: 'boom' }), 'boom')
  assert.equal(errorOf({ ok: false }), undefined)
  assert.equal(errorOf(null), undefined)
  assert.equal(errorOf('x'), undefined)
  assert.equal(errorOf(undefined, 'plain'), '抛错: plain')
  assert.equal(errorOf({ error: 'auth Bearer sk-live-abcdefgh' }).includes('sk-live-abcdefgh'), false)
  assert.ok(errorOf({ error: 'x'.repeat(900) }).length <= 501)
})

test('composeSearchEntry：五问合成（驱动真实合成函数）', () => {
  const e = composeSearchEntry({
    now: 1000, phase: 'call', build: '0.1.0@1', op: 'search_web',
    args: { query: '爱丽丝', engines: ['duckduckgo', 'brave'], pages: 1 },
    durationMs: 4200,
    result: { ok: true, count: 12, results: [{}, {}] },
  })
  assert.equal(e.atMs, 1000)
  assert.equal(e.op, 'search_web')                 // Q2 哪个工具
  assert.equal(e.params, 'query=爱丽丝;engines=duckduckgo|brave')  // Q2 输入侧（pages 不在白名单）
  assert.equal(e.count, 12)                        // Q4 聚合去重后条数
  assert.equal(e.durationMs, 4200)                 // Q5
  assert.equal(e.ok, true)
  assert.equal(e.channel, '')
  assert.equal(e.error, undefined)
  // 反爬链：通道级别 + 走到第几级
  const r = composeSearchEntry({
    now: 2000, phase: 'call', build: '0.1.0@1', op: 'fetch_robust',
    args: { url: 'https://x/y' }, durationMs: 9000,
    result: { ok: true, channel: 'headless', attempts: [{ channel: 'fingerprint' }, { channel: 'headless' }], content: 'x' },
  })
  assert.equal(r.channel, 'headless')              // Q3 降级到哪一级
  assert.equal(r.attempts, 2)                      // Q3 走了几级
  assert.equal(r.count, 0)                         // 该工具返回体无数组 → 0（不编造）
  // 抛错：ok=false + error 前缀 + count 归零
  const t = composeSearchEntry({ now: 3000, phase: 'call', build: 'b', op: 'x', args: {}, durationMs: 1, thrown: new Error('boom') })
  assert.equal(t.ok, false)
  assert.match(t.error, /^抛错: boom/)
  assert.equal(t.count, 0)
  // 无 result 且无 thrown（退化输入）→ ok=false，不抛
  assert.equal(composeSearchEntry({ now: 1, phase: 'call', build: 'b', op: 'x', args: {}, durationMs: 0 }).ok, false)
})

test('serializeTraceEntry：单行 + 键序固定 + error 缺省不污染', () => {
  const line = serializeTraceEntry(base({}))
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'atMs', 'phase', 'build', 'op', 'params', 'count', 'channel', 'attempts', 'durationMs', 'ok',
  ])
  const withErr = JSON.parse(serializeTraceEntry(base({ ok: false, error: 'boom' })))
  assert.equal(Object.keys(withErr).at(-1), 'error')
})

test('parseTraceEntries：坏行/半行/空行/null/字符串全部跳过，不抛', () => {
  const good = serializeTraceEntry(base({}))
  const text = ['', good, '  ', '{"atMs":1,"phase":"call"', '{"phase":"call"}', 'null', '"str"', '###'].join('\n')
  const parsed = parseTraceEntries(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].op, 'search_web')
})

test('readTraceEntries：缺失文件/目录误当文件 → 空数组（不抛）', () => {
  assert.deepEqual(readTraceEntries(join(tmp, 'nope', 'search-trace.jsonl')), [])
  assert.deepEqual(readTraceEntries(tmp), [])
})

test('appendTraceEntry：正常追加可回读；空文件读回空数组', () => {
  const path = join(tmp, 'ok', 'search-trace.jsonl')
  const emptyPath = join(tmp, 'empty-trace.jsonl')
  writeFileSync(emptyPath, '', 'utf8')
  assert.deepEqual(readTraceEntries(emptyPath), [])
  assert.equal(appendTraceEntry(path, base({ phase: 'boot', op: 'apply' })), true)
  assert.equal(appendTraceEntry(path, base({ op: 'fetch_robust', channel: 'headless', attempts: 2 })), true)
  const back = readTraceEntries(path)
  assert.deepEqual(back.map((e) => e.op), ['apply', 'fetch_robust'])
  assert.equal(back[1].channel, 'headless')
  assert.equal(readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').length, 2)
})

test('尸体测试：父路径是普通文件 → 返回 false 且不抛（观测不反噬检索）', () => {
  const blocker = join(tmp, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  assert.doesNotThrow(() => {
    assert.equal(appendTraceEntry(join(blocker, 'search-trace.jsonl'), base({})), false)
    assert.equal(searchTrace(base({}), { path: join(blocker, 'search-trace.jsonl'), now: 1 }), false)
  })
})

test('searchTrace：now 覆盖 atMs 落一行；不可写路径返回 false', () => {
  const path = join(tmp, 'thin', 'search-trace.jsonl')
  assert.equal(searchTrace(base({ op: 'search_deep' }), { path, now: 42 }), true)
  const [line] = readTraceEntries(path)
  assert.equal(line.atMs, 42)
  assert.equal(line.op, 'search_deep')
  assert.equal(searchTrace(base({}), { path: join(tmp, 'blocker', 'x.jsonl'), now: 43 }), false)
})

test('隐私尸体测试端到端：password / apiKey / token / Bearer 落盘后搜不到（红线）', () => {
  const path = join(tmp, 'privacy', 'search-trace.jsonl')
  const secrets = ['hunter2secret', 'sk-live-9f8e7d6c5b4a3210', 'AbCdEf0123456789AbCdEf0123456789']
  // ① search_leaks：password 参数（**最危险的一个**——密码查询天然带明文口令）
  const leak = composeSearchEntry({
    now: 1, phase: 'call', build: 'b', op: 'search_leaks',
    args: { password: 'hunter2secret' }, durationMs: 300, result: { ok: true, found: false },
  })
  assert.equal(leak.params, '', 'password 必须整键丢弃')
  assert.equal(searchTrace(leak, { path, now: 1 }), true)
  // ② 带 key 的调用 + 上游把 Authorization 写进 error
  const keyed = composeSearchEntry({
    now: 2, phase: 'call', build: 'b', op: 'search_serp',
    args: { query: '爱丽丝', apiKey: 'sk-live-9f8e7d6c5b4a3210', token: 'AbCdEf0123456789AbCdEf0123456789', url: 'https://x/api_key=hunter2secret' },
    durationMs: 500,
    result: { ok: false, error: 'HTTP 401: Authorization: Bearer AbCdEf0123456789AbCdEf0123456789 rejected' },
  })
  assert.equal(keyed.params.includes('apiKey'), false)
  assert.equal(keyed.params.includes('token'), false)
  assert.equal(searchTrace(keyed, { path, now: 2 }), true)
  const raw = readFileSync(path, 'utf8')
  for (const s of secrets) assert.equal(raw.includes(s), false, '凭据不得落盘: ' + s)
  assert.match(raw, /\[redacted\]/)                 // 擦除确实发生了（排除「没写进去」的假绿）
  const lines = parseTraceEntries(raw)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].params, '')                  // 白名单之外 ⇒ 空
  assert.match(lines[1].params, /query=爱丽丝/)       // 非敏感参数仍然可读（Q2 保真）
})

test('构建自证：buildStamp/readPackageVersion/mtimeOf（版本读不到退化为 unknown@mtime）', () => {
  const root = join(tmp, 'pkg')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8')
  const self = join(root, 'lib', 'index.js')
  writeFileSync(self, '// x', 'utf8')
  assert.equal(readPackageVersion(self), '0.1.0')
  assert.ok(mtimeOf(self) > 0)
  assert.equal(buildStamp(self, '0.1.0'), '0.1.0@' + String(mtimeOf(self)))
  assert.equal(buildStamp(join(root, 'missing.js'), ''), 'unknown@0')
})

test('离线组合：三类工具调用 → 轨迹行一次答出五问（含原缺陷的可观测面）', () => {
  const path = join(tmp, 'combo', 'search-trace.jsonl')
  const mk = (over) => composeSearchEntry({
    now: 7, phase: 'call', build: '0.1.0@1', durationMs: 100, ...over,
  })
  // ① 多引擎聚合去重（Q4：聚合后剩多少条）
  assert.equal(searchTrace(mk({
    op: 'search_web', args: { query: '爱丽丝', engines: ['duckduckgo', 'brave'] },
    result: { ok: true, count: 9, results: new Array(9) },
  }), { path, now: 1 }), true)
  // ② 反爬链降级（Q3：走到 headless 这一级，共 3 次尝试）
  assert.equal(searchTrace(mk({
    op: 'fetch_robust', args: { url: 'https://ddg.example/x' }, durationMs: 26000,
    result: { ok: true, channel: 'headless', attempts: [{ channel: 'fingerprint' }, { channel: 'prewarm' }, { channel: 'headless' }], text: 'x' },
  }), { path, now: 2 }), true)
  // ③ 全链失败（Q3 断点：ok=false + error；这正是「日志一片干净」的那类事故）
  assert.equal(searchTrace(mk({
    op: 'fetch_robust', args: { url: 'https://ddg.example/y' }, durationMs: 31000,
    result: { ok: false, error: '所有通道失败（fingerprint/prewarm/retry/headless）', attempts: [{ channel: 'fingerprint' }, { channel: 'prewarm' }, { channel: 'retry' }, { channel: 'headless' }] },
  }), { path, now: 3 }), true)
  const lines = readTraceEntries(path)
  assert.equal(lines[0].count, 9)                       // Q4 聚合后条数
  assert.equal(lines[1].channel, 'headless')            // Q3 降级到哪一级
  assert.equal(lines[1].attempts, 3)                    // Q3 走了几级
  assert.equal(lines[2].ok, false)
  assert.match(lines[2].error, /所有通道失败/)
  assert.equal(lines[2].attempts, 4)
  assert.equal(lines.every((e) => e.build === '0.1.0@1'), true)  // Q1 构建（每行都有）
  assert.equal(lines.every((e) => typeof e.durationMs === 'number'), true) // Q5 耗时
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})
