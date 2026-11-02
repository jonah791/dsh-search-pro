/**
 * `maxItems` 的**端到端**验证（2026-11-03 · t-df1b9eeb）。
 *
 * 为什么必须有这个文件（而不是只测 `mapApiItems`）：
 * 加一个配置字段要过**七跳**，而漏跳的表现是「工具面能配、类型也过、扫描时不生效」——
 * 静态检查只在**恰好用到该字段**时报错，行为测试是唯一能抓住漏跳的东西。
 * 本次实做就漏了两次：① `intel-scan` 逐字段拼 spec 时没传 maxItems
 * ② `Collected` 没有端点原始数的口径 ⇒ `rawCount` 会把「端点 100 条」报成「5 条」。
 * 两处都是编译过后才被他处的报错/推理逼出来的。
 *
 * 本文件的判据：
 * ① 配了 maxItems ⇒ 扫描结果真的被截断（不是「配了但没用」）
 * ② 截断后 `rawCount` 仍报**端点原始数**（不是收下数）
 * ③ 不配 ⇒ 全收（既有 7 个源不受影响）
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IntelStore } from '../lib/intel-store.js'
import { scanTarget } from '../lib/intel-scan.js'

/** 造一个 100 条的声明式端点，并把 fetch 打桩 */
function stubEndpoint(count) {
  const payload = {
    data: {
      items: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, title: `公告 ${i}` })),
    },
  }
  mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
  }))
}

function makeTarget(spec) {
  return {
    id: 't-api-e2e',
    kind: 'api',
    spec: { url: 'https://api.example.com/x', itemsPath: 'data.items', urlTemplate: 'https://example.com/{id}', ...spec },
    createdAt: '2026-11-03T00:00:00.000Z',
  }
}

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'intel-maxitems-e2e-'))
  try {
    return await fn(new IntelStore(dir))
  } finally {
    mock.restoreAll()
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── 判据③：不配 ⇒ 全收（向后兼容）──────────────────────────────────
test('③ 不配 maxItems ⇒ 100 条全收，rawCount=100', async () => {
  await withStore(async (store) => {
    stubEndpoint(100)
    const r = await scanTarget(makeTarget({}), store, {})
    assert.equal(r.items.length, 100)
    assert.equal(r.rawCount, 100)
  })
})

// ── 判据①：配了必须真的生效 ──────────────────────────────────────────
test('★ ① 配 maxItems=5 ⇒ 扫描结果真的只收 5 条（防「配了但没用」）', async () => {
  await withStore(async (store) => {
    stubEndpoint(100)
    const r = await scanTarget(makeTarget({ maxItems: 5 }), store, {})
    assert.equal(r.items.length, 5,
      '截断没有生效——这正是「字段加了、消费点没接」的形态，静态检查抓不到')
  })
})

// ── 判据②：端点原始数不能丢 ──────────────────────────────────────────
test('★ ② 截断后 rawCount 仍报端点原始数（100），不是收下数（5）', async () => {
  await withStore(async (store) => {
    stubEndpoint(100)
    const r = await scanTarget(makeTarget({ maxItems: 5 }), store, {})
    assert.equal(r.rawCount, 100,
      'rawCount 退化成收下数 ⇒ 「端点 300 条」看起来像「只有 20 条」，下次没人知道要调上界')
    assert.notEqual(r.items.length, r.rawCount, '两个数相等说明截断没发生或口径丢了')
  })
})

// ── 首扫存量不会被灌满 ────────────────────────────────────────────────
test('防灌全量：首扫（库为空）配 maxItems ⇒ 入库条数受上界约束', async () => {
  await withStore(async (store) => {
    stubEndpoint(300)
    const target = makeTarget({ maxItems: 20 })
    await scanTarget(target, store, {})
    const persisted = store.listItems({ targetId: 't-api-e2e', limit: 0 }).items
    assert.equal(persisted.length, 20, '首扫把大端点的存量全灌进库了——这正是本条要防的')
  })
})
