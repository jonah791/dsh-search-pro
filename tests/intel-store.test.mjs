/**
 * 情报持久化层测试（真实文件系统 + 临时目录，零网络）。
 *
 * 本文件锁的是**时间窗**判据（2026-10-17 新增）：推送的本质是**增量通知**，
 * 不是全量列表——「最近 N 小时发现」必须能过滤，且边界要明确。
 *
 * 夹具纪律：一律用 `mkdtempSync` 的隔离目录，**绝不触碰生产 `<DSH_HOME>/intel/`**
 * （夹具不得触碰生产资产——2026-09-15 凭据库夹具事故的教训）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IntelStore } from '../lib/intel-store.js'

const H = 3600_000
const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'intel-store-test-'))
  return { store: new IntelStore(dir), dir }
}

function item(id, foundAt, status = 'new', targetId = 't') {
  return { id, targetId, url: `https://x.example/${id}`, kind: 'paper', foundAt, status }
}

test('★ 时间窗：只有窗内的条目被返回（推送的本质是增量通知）', () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([
      item('a', iso(2 * H)),
      item('b', iso(30 * H)),
      item('c', iso(100 * H)),
    ])
    const r = store.listItems({ since: iso(24 * H) })
    assert.deepEqual(r.items.map((i) => i.id), ['a'])
    // filtered 也必须是窗内计数（口径与 items 一致）——否则「合计 N 条」会把窗外的算进来
    assert.equal(r.filtered, 1)
    // 不给 since ⇒ 全量（向后兼容：旧调用点行为不变）
    assert.equal(store.listItems({}).items.length, 3)
    assert.equal(store.listItems({}).filtered, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 尸体样本：foundAt 无法解析的条目不得被算作「最近新增」', () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([item('good', iso(1 * H)), item('bad', 'not-a-date')])
    const r = store.listItems({ since: iso(24 * H) })
    // 判不出何时发现 ⇒ 不能算「最近新增」。
    // 若实现改成「解析失败就保留」，这条立刻挂——这就是它的区分力。
    assert.deepEqual(r.items.map((i) => i.id), ['good'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('时间窗与状态/目标过滤是 AND（正交叠加，不互相掩盖）', () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([
      item('a', iso(1 * H), 'new', 't'),
      item('b', iso(1 * H), 'seen', 't'),
      item('c', iso(1 * H), 'new', 'other'),
      item('d', iso(50 * H), 'new', 't'),
    ])
    const r = store.listItems({ since: iso(24 * H), status: 'new', targetId: 't' })
    assert.deepEqual(r.items.map((i) => i.id), ['a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('since 传坏值时不得静默变成「全量」或「空」（退化输入显式处理）', () => {
  const { store, dir } = tempStore()
  try {
    store.appendItems([item('a', iso(1 * H)), item('b', iso(100 * H))])
    // Date.parse 失败 ⇒ 判据不生效 ⇒ 退回全量（**不是**静默清空）
    assert.equal(store.listItems({ since: 'garbage' }).items.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
