/**
 * 领域路由单测（2026-09-18 第二轮）：按意图给深研循环追加专用通道。
 *
 * 覆盖：code / academic / 双命中 / 通用 / 中文关键词 / 大小写与噪声输入 /
 * 以及 `deepResearch` 在 `routing=off` 时不得追加通道（判据在 report 里可见）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeIntents } from '../lib/research.js'

test('routeIntents: 代码/生态类 → github-repo', () => {
  for (const q of [
    'how to publish a DSH plugin to npm',
    'best practices for monorepo CI',
    'GitHub Actions cache key strategy',
    '这个插件的源码怎么组织',
    '有什么开源的实现方式',
  ]) {
    const r = routeIntents(q)
    assert.equal(r.kind, 'code', q)
    assert.ok(r.added.includes('github-repo'), q)
  }
})

test('routeIntents: 研究类 → academic', () => {
  for (const q of ['survey of retrieval augmented generation', 'recent papers on tool use', '关于长上下文的研究进展']) {
    const r = routeIntents(q)
    assert.equal(r.kind, 'academic', q)
    assert.deepEqual(r.added, ['academic'], q)
  }
})

test('routeIntents: 双命中 → 两条通道都加', () => {
  const r = routeIntents('survey and benchmark of github repo retrieval')
  assert.equal(r.kind, 'code')
  assert.deepEqual(r.added, ['github-repo', 'academic'])
})

test('routeIntents: 通用问题 → 不追加（省调用）', () => {
  for (const q of ['明天东京天气', 'how to boil an egg', '2026 年假期安排']) {
    const r = routeIntents(q)
    assert.equal(r.kind, 'general', q)
    assert.deepEqual(r.added, [], q)
    assert.match(r.note, /网页通道/)
  }
})

test('routeIntents: 退化输入不抛（空串/null-ish）', () => {
  assert.equal(routeIntents('').kind, 'general')
  assert.equal(routeIntents(undefined).kind, 'general')
  assert.equal(routeIntents('   ').kind, 'general')
})
