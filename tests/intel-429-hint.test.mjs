/**
 * 限流报错必须自带**处置方向**，且判据不能只看状态码（2026-11-03 · t-d4ee2132 / t-198fed4d）。
 *
 * 存在理由：一条 target 被误判 16 天（记录说「从未产出 0 条」，实际在持续产出 58 条）。
 * `HTTP 429 Too Many Requests` 把读者引向「目标坏了」，而实测指向完全不同的方向：
 *   ① 同一 header 组合在**同一轮**实验里 429 与 200 混杂（② [429, 200]）
 *   ② 间隔 4s 的同通道序列 [429, 200, 429]
 *   ③ 所有请求都必须经共享出口节点才能出网（清空代理 env ⇒ 全部 fetch failed）
 * ⇒ 限流是**出口级**的，共享出口上他人流量会波及本请求。
 *
 * ⚠ 第二层（同晚发现）：**不同源用不同状态码表达限流**。
 *   Cloudflare 用 429；GitHub 用 **403** + 文本 "API rate limit exceeded for <IP>"。
 *   实测：intel_scan 对 GitHub search 报 403，同一时刻同出口直连探测是 200、配额还剩 9。
 *   ⇒ 只认 429 会漏掉一半；必须**读源说的话**。
 *
 * 判据：
 * ① 429 ⇒ 报错含限流提示与可操作判据（正向）
 * ② 非限流的 500 / 404 ⇒ **不含**该提示（反向：只测①的话「任何失败都加提示」也能满分）
 * ③ **403 + rate-limit 文本 ⇒ 含**提示；**403 + 其他原因 ⇒ 不含**（防「所有 403 都当限流」）
 * ④ 响应体摘要必须带进报错（GitHub 的 body 带 `for <IP>`，那是判「出口 vs 配额」的唯一一手证据）
 * ⑤ 加了提示不得吞掉原错误（状态码仍在）
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IntelStore } from '../lib/intel-store.js'
import { scanTarget } from '../lib/intel-scan.js'

function stubResponse(status, statusText, body) {
  mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status,
    statusText,
    json: async () => {
      try {
        return JSON.parse(body)
      } catch {
        return {}
      }
    },
    text: async () => body,
  }))
}

function makeTarget() {
  return {
    id: 't-429-hint',
    kind: 'api',
    spec: {
      url: 'https://api.example.com/x',
      itemsPath: 'data.items',
      urlTemplate: 'https://example.com/{id}',
    },
    createdAt: '2026-11-03T00:00:00.000Z',
  }
}

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'intel-429-hint-'))
  try {
    return await fn(new IntelStore(dir))
  } finally {
    mock.restoreAll()
    rmSync(dir, { recursive: true, force: true })
  }
}

const HINT = '不必然是目标不可用'

// ── 判据①：429 必须带处置方向 ────────────────────────────────────────
test('★ ① 429 ⇒ 报错写明限流不是「目标坏了」，并给出可操作判据', async () => {
  await withStore(async (store) => {
    stubResponse(429, 'Too Many Requests', '{"error":"slow down"}')
    const r = await scanTarget(makeTarget(), store, {})
    assert.equal(r.state, 'failed')
    assert.ok(r.error?.includes(HINT), `429 的报错没带处置方向：${r.error}`)
    assert.ok(r.error?.includes('定时扫描'), '缺少「定时扫描长期正常 ⇒ 撞窗口」这条可操作判据')
  })
})

// ── 判据②（反向）：非限流失败不得带提示 ─────────────────────────────
test('★ ② 尸体：500 ⇒ 不含限流提示（防「任何失败都加提示」也满分）', async () => {
  await withStore(async (store) => {
    stubResponse(500, 'Internal Server Error', '{"error":"boom"}')
    const r = await scanTarget(makeTarget(), store, {})
    assert.equal(r.state, 'failed')
    assert.ok(!r.error?.includes(HINT), `500 被误标成限流：${r.error}`)
    assert.ok(r.error?.includes('500'), '状态码本身不能丢')
  })
})

test('★ ② 尸体：404 ⇒ 同样不含限流提示', async () => {
  await withStore(async (store) => {
    stubResponse(404, 'Not Found', 'not here')
    const r = await scanTarget(makeTarget(), store, {})
    assert.equal(r.state, 'failed')
    assert.ok(!r.error?.includes(HINT), `404 被误标成限流：${r.error}`)
  })
})

// ── 判据③：403 要看文本，不能一律当限流 ─────────────────────────────
test('★ ③ 403 + rate-limit 文本（GitHub 形态）⇒ 必须识别为限流', async () => {
  await withStore(async (store) => {
    stubResponse(403, 'Forbidden', '{"message":"API rate limit exceeded for 1.2.3.4. (But here\'s the good news:..."}')
    const r = await scanTarget(makeTarget(), store, {})
    assert.equal(r.state, 'failed')
    assert.ok(r.error?.includes(HINT), `GitHub 的 403 限流没被识别：${r.error}`)
  })
})

test('★ ③ 尸体：403 + 非限流原因 ⇒ **不得**误标成限流', async () => {
  await withStore(async (store) => {
    stubResponse(403, 'Forbidden', '{"message":"Bad credentials"}')
    const r = await scanTarget(makeTarget(), store, {})
    assert.equal(r.state, 'failed')
    assert.ok(!r.error?.includes(HINT), `普通 403 被误标成限流：${r.error}`)
  })
})

// ── 判据④：响应体摘要必须带进报错 ───────────────────────────────────
test('④ 响应体摘要进报错（GitHub 的 body 带 for <IP>，是判出口问题的唯一一手证据）', async () => {
  await withStore(async (store) => {
    stubResponse(403, 'Forbidden', 'API rate limit exceeded for 203.0.113.9')
    const r = await scanTarget(makeTarget(), store, {})
    assert.ok(r.error?.includes('203.0.113.9'), `源给的 IP 证据被扔掉了：${r.error}`)
  })
})

// ── 判据⑤：提示不得吞掉原错误 ────────────────────────────────────────
test('⑤ 加了提示后，状态码与 sourceErrors 仍如实可读', async () => {
  await withStore(async (store) => {
    stubResponse(429, 'Too Many Requests', '')
    const r = await scanTarget(makeTarget(), store, {})
    assert.ok(r.error?.includes('429'), '状态码被提示挤掉了')
    assert.equal(r.foundCount, 0)
    assert.ok((r.sourceErrors ?? []).some((e) => e.includes('429')), 'sourceErrors 里丢了 429')
  })
})
