/**
 * 情报「按目标到期」判据测试（纯函数，零网络）。
 *
 * 存在理由（2026-10-17 · 信息差实证驱动）：此前是**全局单周期**（默认 360 分钟）。
 * 实测币安下架公告（EPIC/QUICK）发布当日即 **−25% ~ −29%**，行情几小时内走完大半
 * ⇒ 6 小时后才看到 = **信号已经走掉了**。改为目标可用 `scanMinutes` 覆盖全局。
 *
 * 本文件锁三种情形 + 一具尸体：自带周期 / 缺省回落 / **从没扫过立刻到期** / 坏值不炸不误判。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dueTargetIds } from '../lib/intel.js'

const MIN = 60_000
const NOW = Date.parse('2026-10-17T02:00:00Z')
const ago = (min) => new Date(NOW - min * MIN).toISOString()
const T = (id, extra = {}) => ({ id, kind: 'api', spec: {}, createdAt: 'x', ...extra })

test('★ 目标自带 scanMinutes ⇒ 用它（快源不被全局 6 小时拖住）', () => {
  const targets = [
    T('fast', { scanMinutes: 30, lastScanAt: ago(45) }),
    T('slow', { scanMinutes: 360, lastScanAt: ago(45) }),
  ]
  // 都是 45 分钟前扫过：30 分钟的到期了，360 分钟的没有
  assert.deepEqual(dueTargetIds(targets, NOW, 360), ['fast'])
})

test('缺省 scanMinutes ⇒ 回落全局', () => {
  const targets = [T('a', { lastScanAt: ago(400) }), T('b', { lastScanAt: ago(100) })]
  assert.deepEqual(dueTargetIds(targets, NOW, 360), ['a'])
})

test('★ 从没扫过 ⇒ 立刻到期（不然新登记的目标要干等一个周期才首扫）', () => {
  const targets = [T('fresh'), T('stale', { lastScanAt: ago(1) })]
  assert.deepEqual(dueTargetIds(targets, NOW, 360), ['fresh'])
})

test('★ 尸体样本：坏 scanMinutes / 坏 lastScanAt 一律不炸，且不误判', () => {
  const targets = [
    T('bad-min-0', { scanMinutes: 0, lastScanAt: ago(400) }), // 0 ⇒ 回落全局 ⇒ 到期
    T('bad-min-neg', { scanMinutes: -5, lastScanAt: ago(400) }), // 负 ⇒ 回落全局 ⇒ 到期
    T('bad-min-str', { scanMinutes: 'x', lastScanAt: ago(400) }), // 字符串 ⇒ 回落全局 ⇒ 到期
    T('bad-last', { lastScanAt: 'not-a-date' }), // 坏时间 ⇒ 立刻到期
  ]
  assert.deepEqual(dueTargetIds(targets, NOW, 360), ['bad-min-0', 'bad-min-neg', 'bad-min-str', 'bad-last'])
})

test('★ 边界：刚好到期算到期，差 1 秒不算（判据是 >= 不是 >）', () => {
  const exactly = [T('t', { scanMinutes: 60, lastScanAt: ago(60) })]
  assert.deepEqual(dueTargetIds(exactly, NOW, 360), ['t'])
  const justBefore = [T('t', { scanMinutes: 60, lastScanAt: new Date(NOW - 60 * MIN + 1000).toISOString() })]
  assert.deepEqual(dueTargetIds(justBefore, NOW, 360), [])
})

test('空目标列表 ⇒ 空（不炸）', () => {
  assert.deepEqual(dueTargetIds([], NOW, 360), [])
})
