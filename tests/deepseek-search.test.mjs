/**
 * DeepSeek 官方 Search API 通道（2026-10-17 接入 · 主人交办「配置到内置搜索」）。
 * 端点/字段以官方文档为准：https://api-docs.deepseek.com/zh-cn/guides/search
 *
 * 本文件锁六件事，**其中三条是尸体样本**（判据必须有区分力，§5.9 规则 2——
 * 只测正路径的测试无法证明它会在坏样本上亮）：
 *  ① 正路径：字段映射（含 `summary` 优先于 `snippet`）
 *  ② 本通道**独有**的增益：按 `rerank_score` 降序（其它通道都没有质量分）
 *  ③ 尸体①：`results: []` ⇒ 返回空数组、不抛（「没搜到」不是故障）
 *  ④ 尸体②：条目缺 `url` ⇒ 被滤掉（url 是去重键与可点击性前提）
 *  ⑤ 尸体③：非 200 ⇒ **抛错**（fail-loud——密钥失效若返回 []，会被读成「没搜到」）
 *  ⑥ 契约与隐私：请求体形状（count 夹在 1–50 / ori_question 截断 128）
 *     + **不得出现 `localization`**（那是「用出口 IP 优先本地化」的入参，属隐私面外扩）
 *
 * 零网络：mock `globalThis.fetch`（沿用 `http-get-attribution.test.mjs` 的装置形状）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { searchDeepSeek } from '../lib/engines.js'

const realFetch = globalThis.fetch
/** 最后一次请求的现场（url / 解析后的 body / headers）——契约类断言都读它。 */
let captured = null

const mockJson = (status, obj) => {
  globalThis.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), headers: opts.headers }
    return { ok: status >= 200 && status < 300, status, json: async () => obj }
  }
}
const restore = () => {
  globalThis.fetch = realFetch
  captured = null
}

test('正路径：字段映射，且 summary 优先于 snippet', async () => {
  mockJson(200, {
    results: [
      { title: 'T1', url: 'https://a.example/x', snippet: '短的', summary: '更完整的摘要', rerank_score: 1.2 },
      { title: 'T2', url: 'https://b.example/y', snippet: '只有 snippet', rerank_score: 0.5 },
    ],
  })
  try {
    const out = await searchDeepSeek('q', 'k', 5)
    assert.equal(out.length, 2)
    assert.deepEqual(out.map((r) => r.source), ['deepseek', 'deepseek'])
    assert.equal(out.find((r) => r.url === 'https://a.example/x').snippet, '更完整的摘要', 'summary 存在时必须优先取它')
    assert.equal(out.find((r) => r.url === 'https://b.example/y').snippet, '只有 snippet', 'summary 缺失时回退 snippet')
  } finally {
    restore()
  }
})

test('★ 本通道独有的增益：按 rerank_score 降序（乱序输入 ⇒ 有序输出）', async () => {
  mockJson(200, {
    results: [
      { title: '低', url: 'https://low.example', rerank_score: 0.4 },
      { title: '高', url: 'https://high.example', rerank_score: 2.9 },
      { title: '中', url: 'https://mid.example', rerank_score: 1.5 },
    ],
  })
  try {
    const out = await searchDeepSeek('q', 'k', 5)
    assert.deepEqual(out.map((r) => r.title), ['高', '中', '低'])
  } finally {
    restore()
  }
})

test('尸体①：results 为空 ⇒ 返回 []，不抛（「没搜到」不是故障）', async () => {
  mockJson(200, { results: [] })
  try {
    assert.deepEqual(await searchDeepSeek('q', 'k', 5), [])
  } finally {
    restore()
  }
})

test('尸体②：条目缺 url ⇒ 被滤掉（url 是去重键与可点击前提）', async () => {
  mockJson(200, { results: [{ title: '没有 url' }, { title: '有 url', url: 'https://ok.example' }] })
  try {
    const out = await searchDeepSeek('q', 'k', 5)
    assert.equal(out.length, 1)
    // ⚠ 断言用 match 而非严格相等：`normalizeUrl` 会补尾斜杠（`https://ok.example` → `.../`），
    //   那是**它的**行为、不是本条判据的被检对象。断言过窄会把无关变更读成回归。
    assert.match(out[0].url, /^https:\/\/ok\.example\/?$/)
  } finally {
    restore()
  }
})

test('尸体③：非 200 ⇒ 抛错（fail-loud——密钥失效不得被读成「没搜到」）', async () => {
  mockJson(401, { error: 'unauthorized' })
  try {
    await assert.rejects(() => searchDeepSeek('q', 'k', 5), /HTTP 401/)
  } finally {
    restore()
  }
})

test('契约：count 夹在官方 1–50；ori_question 截断 128；headers 带 Bearer', async () => {
  mockJson(200, { results: [] })
  try {
    await searchDeepSeek('q', 'sk-test', 999, { oriQuestion: 'x'.repeat(300) })
    assert.equal(captured.url, 'https://api.deepseek.com/v1/tools/search')
    assert.equal(captured.body.query, 'q')
    assert.equal(captured.body.count, 50, 'count 上界 50（官方）')
    assert.equal(captured.body.ori_question.length, 128, 'ori_question 截断 128（官方上界）')
    assert.equal(captured.body.need_content, false, '正文留给 fetch 层，这里只要摘要')
    assert.equal(captured.headers.Authorization, 'Bearer sk-test')

    await searchDeepSeek('q', 'sk-test', 0)
    assert.equal(captured.body.count, 1, 'count 下界 1（官方）')
  } finally {
    restore()
  }
})

test('隐私：请求体不得出现 localization（那是「用出口 IP 优先本地化」的入参）', async () => {
  mockJson(200, { results: [] })
  try {
    await searchDeepSeek('q', 'k', 5)
    assert.ok(!('localization' in captured.body), 'localization 属隐私面外扩，不得传')
  } finally {
    restore()
  }
})
