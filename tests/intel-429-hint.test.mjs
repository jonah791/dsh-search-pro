/**
 * 429 的报错必须自带**处置方向**（2026-11-03 · t-d4ee2132）。
 *
 * 存在理由：一条 target 被误判了 16 天（记录说「从未产出 0 条」，实际在持续产出 58 条）。
 * `HTTP 429 Too Many Requests` 这句话本身把读者引向「目标坏了」，而实测指向完全不同的方向：
 *   ① 同一 header 组合在**同一轮**实验里 429 与 200 混杂（② [429, 200]）
 *   ② 间隔 4s 的同通道序列 [429, 200, 429]
 *   ③ 所有请求都必须经共享出口节点才能出网（清空代理 env ⇒ 全部 fetch failed）
 * ⇒ 429 是**出口级**限流，共享出口上他人流量会波及本请求。
 *
 * 判据：
 * ① 429 ⇒ 报错含「出口级限流」提示（正向）
 * ② 非 429（500 / 404）⇒ **不含**该提示 —— 只测①的话，「任何失败都加提示」也能满分，
 *    而那样的实现在读者眼里等于没有信息。
 * ③ 加了提示不得吞掉原错误（state 仍 failed，状态码仍可读）
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IntelStore } from '../lib/intel-store.js'
import { scanTarget } from '../lib/intel-scan.js'

function stubStatus(status, statusText) {
  mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status,
    statusText,
    json: async () => ({ error: `stub ${status}` }),
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

const HINT = '出口级限流'

// ── 判据①：429 必须带处置方向 ────────────────────────────────────────
test('★ ① 429 ⇒ 报错里写明「出口级限流」，并给出「不是目标坏了」的判断路径', async () => {
  await withStore(async (store) => {
    stubStatus(429, 'Too Many Requests')
    const r = await scanTarget(makeTarget(), store, {})
    assert.equal(r.state, 'failed')
    assert.ok(r.error?.includes(HINT), `429 的报错没带处置方向，读者只会看到「目标坏了」：${r.error}`)
    assert.ok(r.error?.includes('定时扫描'), '缺少「定时扫描长期正常 ⇒ 撞窗口」这条可操作判据')
  })
})

// ── 判据②（反向）：非 429 不得带该提示 ───────────────────────────────
test('★ ② 尸体：500 ⇒ 报错**不含**出口限流提示（防「任何失败都加提示」也满分）', async () => {
  await withStore(async (store) => {
    stubStatus(500, 'Internal Server Error')
    const r = await scanTarget(makeTarget(), store, {})
    assert.equal(r.state, 'failed')
    assert.ok(!r.error?.includes(HINT), `500 被误标成出口限流：${r.error}`)
    assert.ok(r.error?.includes('500'), '状态码本身不能丢')
  })
})

test('★ ② 尸体：404 ⇒ 同样不含出口限流提示', async () => {
  await withStore(async (store) => {
    stubStatus(404, 'Not Found')
    const r = await scanTarget(makeTarget(), store, {})
    assert.equal(r.state, 'failed')
    assert.ok(!r.error?.includes(HINT), `404 被误标成出口限流：${r.error}`)
  })
})

// ── 判据③：提示不得吞掉原错误 ────────────────────────────────────────
test('③ 429 加了提示后，状态码与 sourceErrors 仍如实可读', async () => {
  await withStore(async (store) => {
    stubStatus(429, 'Too Many Requests')
    const r = await scanTarget(makeTarget(), store, {})
    assert.ok(r.error?.includes('429'), '状态码被提示挤掉了')
    assert.equal(r.foundCount, 0)
    assert.ok((r.sourceErrors ?? []).some((e) => e.includes('429')), 'sourceErrors 里丢了 429')
  })
})
