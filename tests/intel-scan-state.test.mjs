/**
 * 目标扫描「结果态」测试（2026-10-31 · t-dd31c6e6）。
 *
 * 事故形状：`intel_watch(list)` 每个目标只显示 `上次 <时间>`，而 `lastScanAt` 在**失败时也推进**
 * ⇒ 一个连续 429 的源与健康源在唯一巡检视图里**逐字相同**（2026-10-17 arxiv-deepweb 实测：
 * 双双 429、`state: failed`，list 仍显示「上次 11:45」，与健康的 api-okx-listing 无任何区别）。
 * 主体若只看 list，会把一个完全不可用的源读成正常。
 *
 * 三条判据（逐条覆盖）：
 * ① 失败 ⇒ 落盘 `lastScanState='failed'` + `lastScanError`，且 list 响亮标出
 * ② 成功 ⇒ 失败标记被清掉（不能一失败就永久红）
 * ③ 老记录无该字段 ⇒ 读作「未知」，**不是** ok（这正是本条要治的病）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanTarget } from '../lib/intel-scan.js'
import { IntelStore } from '../lib/intel-store.js'
import { renderIntelWatch } from '../lib/index.js'

const tmpStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'intel-state-'))
  return { store: new IntelStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const text = (v) => renderIntelWatch({}, v)[0].text
const now = () => new Date().toISOString()

test('① 失败扫描 ⇒ 落盘 failed + 截断后的 error，且 list 显示「⚠ 上次失败」', async () => {
  const { store, cleanup } = tmpStore()
  try {
    // 不可达端口 ⇒ fetch 抛错 ⇒ sourceErrors ⇒ 全源失败 ⇒ state='failed'（不依赖外网）
    const target = { id: 'dead-api', kind: 'api', spec: { url: 'http://127.0.0.1:1/nope', itemsPath: 'a' }, createdAt: now() }
    store.upsertTarget(target)
    const r = await scanTarget(target, store)
    assert.equal(r.state, 'failed', '扫描结果必须是 failed')

    const saved = store.listTargets().find((t) => t.id === 'dead-api')
    assert.equal(saved.lastScanState, 'failed', '落盘必须记 failed')
    assert.ok(saved.lastScanError && saved.lastScanError.length > 0, '落盘必须带失败原因')
    assert.ok(saved.lastScanError.length <= 200, `失败原因必须截断到 200，实际 ${saved.lastScanError.length}`)

    const t = text({ ok: true, count: 1, targets: store.listTargets(), dir: '/x' })
    assert.match(t, /⚠ 上次失败/, `list 必须响亮标出失败：${t}`)
  } finally { cleanup() }
})

test('② 成功一次 ⇒ 失败标记被清掉（不能一失败就永久红）', () => {
  const { store, cleanup } = tmpStore()
  try {
    store.upsertTarget({
      id: 'x', kind: 'site', spec: { url: 'https://x' }, createdAt: now(),
      lastScanState: 'failed', lastScanError: 'boom',
    })
    // ⚠ 这里直接调 patchTarget 而不跑一次真成功扫描：api 类的 fetch 没有注入点，真成功要外网。
    //   验的是「清空语义」这一半；「成功时确实走这条 patch」由 scanTarget 的**单一落点**结构保证
    //   （4 个 return 点全在 scanTargetCore 里，状态只由外层那一次 patchTarget 写）。
    store.patchTarget('x', { lastScanState: 'ok', lastScanError: undefined })
    const saved = store.listTargets().find((t) => t.id === 'x')
    assert.equal(saved.lastScanState, 'ok')
    assert.equal(saved.lastScanError, undefined, 'error 必须被清掉（不是留空串）')

    const t = text({ ok: true, count: 1, targets: store.listTargets(), dir: '/x' })
    assert.ok(!t.includes('上次失败'), `成功后不得再显示失败：${t}`)
    assert.ok(!t.includes('结果未知'), `ok 是已知态，不该说未知：${t}`)
  } finally { cleanup() }
})

test('★ 判据③ 老记录无 lastScanState ⇒ 显示「结果未知」，不许读成健康', () => {
  const t = text({
    ok: true, count: 1, dir: '/x',
    targets: [{ id: 'old', kind: 'site', spec: { url: 'https://x' }, lastScanAt: '2026-10-17T00:00:00.000Z' }],
  })
  assert.match(t, /结果未知/, `缺字段必须显形为未知：${t}`)
  assert.ok(!t.includes('上次失败'), '未知不等于失败（两种状态处置相反，不能混）')
})

test('ok 态不加噪音标记（否则读数被自己的装饰淹没）', () => {
  const t = text({
    ok: true, count: 1, dir: '/x',
    targets: [{ id: 'good', kind: 'site', spec: { url: 'https://x' }, lastScanAt: '2026-10-17T00:00:00.000Z', lastScanState: 'ok' }],
  })
  assert.ok(!t.includes('结果未知'), t)
  assert.ok(!t.includes('上次失败'), t)
  assert.match(t, /上次 /, '时间本身仍要显示')
})

test('失败原因过长时 list 渲染截断（不把 200 字符全塞进一行）', () => {
  const t = text({
    ok: true, count: 1, dir: '/x',
    targets: [{
      id: 'long', kind: 'site', spec: { url: 'https://x' }, lastScanAt: '2026-10-17T00:00:00.000Z',
      lastScanState: 'failed', lastScanError: 'y'.repeat(200),
    }],
  })
  assert.ok(t.includes('…'), `超长错误必须截断并加省略号：${t}`)
  assert.ok(!t.includes('y'.repeat(120)), '不得整段塞进去')
})

test('failed 但无 error 文本时仍标出失败（信息少不等于健康）', () => {
  const t = text({
    ok: true, count: 1, dir: '/x',
    targets: [{ id: 'f2', kind: 'site', spec: { url: 'https://x' }, lastScanAt: '2026-10-17T00:00:00.000Z', lastScanState: 'failed' }],
  })
  assert.match(t, /⚠ 上次失败/, t)
})
