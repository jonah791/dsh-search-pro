/**
 * channel-diag 单测：纯分类（每个形状一份尸体样本）+ 薄 I/O 的安全路径。
 *
 * 运行：`npm run build && node --test tests/channel-diag.test.mjs`
 *
 * 纪律（AGENTS.md §5.9 规则 2）：**恒为空的输出不是证据**——分类器若恒返回 `unknown`，
 * 也会让「形状都判对了」的断言全绿通过。所以每个形状都喂一份**已知该被判出**的样本。
 * 夹具落在系统临时目录，**绝不触碰生产资产**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { appendChannelDiag, channelDiagPath, classifyDdgZero, classifyParallelZero } from '../lib/channelDiag.js'

// ───────────────────────── DDG：五种形状的尸体样本 ─────────────────────────

test('ddg · 反爬页 ⇒ anomaly（不是「查询没结果」）', () => {
  const html = '<html><head><title>DuckDuckGo</title></head><body>Unfortunately, bots use DuckDuckGo too. unusual traffic</body></html>'
  const { shape, features } = classifyDdgZero(html)
  assert.equal(shape, 'anomaly')
  assert.equal(features.anomaly, true)
})

test('ddg · 真无结果页 ⇒ no-results-text（判据顺序：必须排在 no-blocks 之前）', () => {
  // 真无结果页**本来就没有结果块**——若先判 blocks===0，这一页会被误判成「结构变了」
  const html = '<html><head><title>q at DuckDuckGo</title></head><body><div class="no-results">No results found for that query.</div></body></html>'
  const { shape } = classifyDdgZero(html)
  assert.equal(shape, 'no-results-text')
  assert.notEqual(shape, 'no-blocks')
})

test('ddg · 无结果块也无无结果文案 ⇒ no-blocks（选择器失效）', () => {
  const html = '<html><head><title>DDG</title></head><body><div class="something-else">…</div></body></html>'
  assert.equal(classifyDdgZero(html).shape, 'no-blocks')
})

test('ddg · 有块无锚点 ⇒ blocks-no-anchors（版式微调）', () => {
  const html = '<html><title>t</title><div class="result"><span>anchor 类名换了</span></div></html>'
  assert.equal(classifyDdgZero(html).shape, 'blocks-no-anchors')
})

test('ddg · 有锚点但解析 0 条 ⇒ all-ads-filtered（全被广告过滤）', () => {
  const html = '<html><title>t</title><div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">广告</a></div></html>'
  assert.equal(classifyDdgZero(html, 0).shape, 'all-ads-filtered')
  // 同一个页面，若调用方没传解析条数（parsed=-1）⇒ 判不出该形状，只能落到 unknown
  assert.equal(classifyDdgZero(html).shape, 'unknown')
})

test('ddg · 正常页（金标准）不被误判成任何失败形状，且特征如实记录', () => {
  const html = '<html><title>ok</title><div class="result"><a class="result__a" href="https://example.com/a">A</a></div></html>'
  const { shape, features } = classifyDdgZero(html, 5)
  assert.equal(shape, 'unknown') // 不在五种失败形状里
  assert.equal(features.blocks, 1)
  assert.equal(features.resultA, 1)
  assert.equal(features.parsed, 5)
  assert.equal(features.anomaly, false)
  assert.equal(features.noResultsText, false)
  assert.ok(Number(features.len) > 0)
})

// ─────────────────────── parallel：四处静默 return 的形状 ───────────────────────

test('parallel · 响应里没有 text 节点 ⇒ no-text-node（MCP 契约变了）', () => {
  const { shape, features } = classifyParallelZero({ hasText: false, textLen: 0, textHead: '', parseOk: false, resultsRaw: 0, afterFilter: 0 })
  assert.equal(shape, 'no-text-node')
  assert.equal(features.hasText, false)
})

test('parallel · 有文本但不是 JSON ⇒ text-not-json（SSE 流最可疑，textHead 是证据）', () => {
  const head = 'data: {"jsonrpc":"2.0","result":{"content":[{"text":"{…}"}]}}\n\n'
  const { shape, features } = classifyParallelZero({ hasText: true, textLen: 1200, textHead: head, parseOk: false, resultsRaw: 0, afterFilter: 0 })
  assert.equal(shape, 'text-not-json')
  assert.match(String(features.textHead), /^data: /)
})

test('parallel · 解析成功但 results 为空 ⇒ empty-results（真 0 结果，记 ok:0 诚实）', () => {
  const { shape, features } = classifyParallelZero({ hasText: true, textLen: 40, textHead: '{"results":[]}', parseOk: true, resultsRaw: 0, afterFilter: 0 })
  assert.equal(shape, 'empty-results')
  assert.equal(features.resultsRaw, 0)
})

test('parallel · 有结果但全无 url ⇒ all-filtered（字段名变了）', () => {
  const { shape, features } = classifyParallelZero({ hasText: true, textLen: 400, textHead: '{"results":[…]', parseOk: true, resultsRaw: 3, afterFilter: 0 })
  assert.equal(shape, 'all-filtered')
  assert.equal(features.resultsRaw, 3)
})

// ───────────────────────── 薄 I/O：写盘 + 观测不反噬 ─────────────────────────

test('现场快照：路径是纯函数（与调用轨迹同目录）', () => {
  assert.equal(channelDiagPath('/home/x'), join('/home/x', 'search-channel-diag.jsonl'))
})

test('现场快照：显式 home **优先于**环境变量（防夹具写生产）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chan-diag-prec-'))
  try {
    const ok = appendChannelDiag(
      { atMs: 1, engine: 'duckduckgo', shape: 'no-blocks', query: 'q', elapsedMs: 1, features: {} },
      { home: dir, env: { DSH_HOME: join(dir, 'should-not-be-used') } },
    )
    assert.equal(ok, true)
    assert.equal(existsSync(channelDiagPath(dir)), true, '显式 home 必须是落点')
    assert.equal(existsSync(join(dir, 'should-not-be-used')), false, '环境变量不得盖过显式 home')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('现场快照：能写入、可回读、query 截断 200', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chan-diag-'))
  try {
    const ok = appendChannelDiag(
      { atMs: 1, engine: 'duckduckgo', shape: 'anomaly', query: 'x'.repeat(500), elapsedMs: 12, features: { len: 3 } },
      { home: dir },
    )
    assert.equal(ok, true)
    const file = channelDiagPath(dir)
    assert.equal(existsSync(file), true)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const entry = JSON.parse(lines[0])
    assert.equal(entry.engine, 'duckduckgo')
    assert.equal(entry.shape, 'anomaly')
    assert.equal(entry.query.length, 200) // 截断生效
    assert.equal(entry.features.len, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('现场快照：路径不可写 ⇒ 返回 false 且**不抛**（观测绝不反噬检索）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chan-diag-bad-'))
  try {
    // 拿一个**文件**当目录用 ⇒ mkdir 必失败
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir', 'utf8')
    let threw = false
    let ret = true
    try {
      ret = appendChannelDiag(
        { atMs: 1, engine: 'parallel', shape: 'no-text-node', query: 'q', elapsedMs: 1, features: {} },
        { home: blocker },
      )
    } catch {
      threw = true
    }
    assert.equal(threw, false, '埋点失败不得抛出')
    assert.equal(ret, false, '失败必须如实返回 false')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
