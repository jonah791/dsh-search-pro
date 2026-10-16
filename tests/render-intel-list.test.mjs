/**
 * intel_list 渲染层测试（纯函数，零 IO）。
 *
 * 存在理由（2026-10-17 线上实测）：批量改状态分支返回 `{ok,count,note,results}`，
 * 而 render 按「列条目」形状渲染 ⇒ 「标记 3/3 条 → dropped」被渲染成
 * 「# 情报条目：0 条 · 监控目标 0 个（无匹配条目）」——**执行正确而读数说没找到**。
 * 与 kindTag 那次同型：**新增返回形状没同步渲染层**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderIntelList } from '../lib/index.js'

const text = (v) => renderIntelList({}, v)[0].text

test('★ 尸体样本：批量改状态的 note 必须显示（不得渲染成「0 条 · 无匹配条目」）', () => {
  // 若 render 退回「先判 ok 再走列表分支」，这条立刻挂——这就是它的区分力
  const t = text({ ok: true, count: 0, note: '标记 3/3 条 → dropped', results: [] })
  assert.match(t, /标记 3\/3 条/)
  assert.ok(!t.includes('0 条'), `不得出现「0 条」假读数：${t}`)
  assert.ok(!t.includes('无匹配条目'), `不得出现「无匹配条目」：${t}`)
})

test('★ 部分失败：note 必须带 ⚠ 且完整保留（未找到清单不许丢）', () => {
  const t = text({ ok: false, count: 0, note: '标记 2/3 条 → dropped · 未找到 1 条：x', results: [] })
  assert.match(t, /^⚠ /)
  assert.match(t, /未找到 1 条/)
})

test('列条目形状不受影响（回归锁）', () => {
  const t = text({
    ok: true,
    count: 1,
    filtered: 7,
    stats: { total: 9, targets: 2, byStatus: { new: 9 }, byKind: { paper: 9 } },
    items: [{ kind: 'paper', status: 'new', foundAt: '2026-10-17T00:00:00.000Z', targetId: 't', title: 'T', url: 'https://x' }],
  })
  assert.match(t, /情报条目：9 条 · 监控目标 2 个/)
  assert.match(t, /命中 7/)
})

test('失败形状仍走 error 分支（note 缺失时）', () => {
  assert.equal(text({ ok: false, error: '存储不可用' }), '存储不可用')
  assert.equal(text({ ok: false }), '失败')
})
