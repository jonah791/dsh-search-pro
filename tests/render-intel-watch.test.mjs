/**
 * intel_watch 渲染层测试（纯函数，零 IO）。
 *
 * 存在理由（2026-10-17 线上实测）：`remove` 分支返回的形状只有 note
 * （**不返回 target，也不返回 targets**），而 render 的「尚无监控目标」判据是
 * `!v.target` ⇒ 误判 ⇒ 移除 1 个目标后读数说「（尚无监控目标——用 intel_watch action=add 登记）」，
 * **而实际还有 5 个** —— 读数说数据没了，数据还在（与 renderIntelList 那次同型）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderIntelWatch } from '../lib/index.js'

const text = (v) => renderIntelWatch({}, v)[0].text

test('★ 尸体样本：remove 分支的 note 不得触发「尚无监控目标」假读数', () => {
  // 若判据退回 `!v.target`，这条立刻挂——这就是它的区分力
  const t = text({ ok: true, count: 0, note: '已移除 arxiv-deepweb（快照一并清掉，重加不会继承旧快照）', results: [] })
  assert.match(t, /已移除 arxiv-deepweb/)
  assert.ok(!t.includes('尚无监控目标'), `不得出现假读数：${t}`)
})

test('★ 真的没有目标时（列表响应 + 空）仍要说那句话（判据不许修过头）', () => {
  const t = text({ ok: true, count: 0, targets: [], dir: '/x' })
  assert.match(t, /尚无监控目标/)
})

test('列表响应带目标：正常渲染，不说「尚无」', () => {
  const t = text({
    ok: true,
    count: 1,
    targets: [{ id: 'a', kind: 'site', spec: { url: 'https://x' }, lastScanAt: '2026-10-17T00:00:00.000Z' }],
    dir: '/x',
  })
  assert.match(t, /监控目标（1）/)
  assert.ok(!t.includes('尚无监控目标'))
})

test('add 分支（note + 无 targets）同样不误报', () => {
  const t = text({ ok: true, count: 0, note: '已登记 x', results: [] })
  assert.match(t, /已登记 x/)
  assert.ok(!t.includes('尚无监控目标'))
})
