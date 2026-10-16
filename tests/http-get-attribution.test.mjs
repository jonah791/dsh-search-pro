/**
 * httpGet 的错误归因测试（mock fetch，零网络）。
 *
 * 存在理由（2026-10-17 实测抓出）：arxiv 被限速返回 429，但**响应耗时 16.2s**，
 * 而旧超时是 15s ⇒ 在响应到达前就 abort，错误信息变成裸的
 * `This operation was aborted` —— **「被限速」被读成「超时」**，归因方向被误导
 * （我会去查网络/超时配置，而真因是限速）。
 *
 * 本文件锁：429 必须报「被限速」；超时必须报「请求超时（Nms）」且带可读原因；
 * **两者不得同貌**——这是判据的分辨力所在（§5.10 语义精确性）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { httpGet } from '../lib/util.js'

const realFetch = globalThis.fetch
const mock = (impl) => {
  globalThis.fetch = impl
}
const restore = () => {
  globalThis.fetch = realFetch
}

const resp = (status, body = '', headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
})

test('★ 429 ⇒ 报「被限速」（而不是裸的 aborted——这是归因是否被误导的分水岭）', async () => {
  mock(async () => resp(429, 'Rate exceeded.'))
  try {
    await assert.rejects(
      () => httpGet('https://x'),
      (e) => {
        assert.match(e.message, /429/)
        assert.match(e.message, /被限速/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('429 带 Retry-After ⇒ 报出来（可退避的量）', async () => {
  mock(async () => resp(429, '', { 'retry-after': '120' }))
  try {
    await assert.rejects(() => httpGet('https://x'), /Retry-After: 120s/)
  } finally {
    restore()
  }
})

test('★ 超时 ⇒ 报「请求超时（Nms）」+ 可读原因（不是裸 AbortError）', async () => {
  // 模拟「对端一直不答」：fetch 挂住，直到 signal abort
  mock(
    (_u, o) =>
      new Promise((_res, rej) => {
        o.signal.addEventListener('abort', () =>
          rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
        )
      }),
  )
  try {
    await assert.rejects(
      () => httpGet('https://x', { timeoutMs: 60 }),
      (e) => {
        assert.match(e.message, /请求超时（60ms）/)
        assert.ok(!/^This operation was aborted$/.test(e.message), '不得是裸 AbortError')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('其他非 2xx ⇒ 报 HTTP <code>（原有行为不回归）', async () => {
  mock(async () => resp(500))
  try {
    await assert.rejects(() => httpGet('https://x'), /HTTP 500/)
  } finally {
    restore()
  }
})

test('正常响应 ⇒ 返回文本', async () => {
  mock(async () => resp(200, 'hello'))
  try {
    assert.equal(await httpGet('https://x'), 'hello')
  } finally {
    restore()
  }
})
