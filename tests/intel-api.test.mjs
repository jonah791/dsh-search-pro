/**
 * 声明式 JSON API 源 · 纯函数层测试。
 *
 * 样本取自 2026-10-17 实测的币安公告端点真实响应（截取）——
 * 不是构造样本：真实响应的形状（嵌套 catalogs[0].articles）正是路径映射要对付的东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickPath, renderTemplate, mapApiItems } from '../lib/intel-api.js'

/** 实测响应截取（2026-10-17 · bapi/composite/v1/public/cms/article/list/query） */
const BINANCE = {
  code: '000000',
  message: null,
  data: {
    catalogs: [
      {
        catalogId: 48,
        catalogName: 'New Cryptocurrency Listing',
        articles: [
          {
            id: 287560,
            code: 'e52ef13311eb4e1a96f07099152e61d5',
            title: 'Binance Will Add 4 bStocks Tokenized Securities as Collateral Asset - 2026-10-14',
            releaseDate: 1791948608368,
          },
          {
            id: 286557,
            code: '1dfe10f0e0fb4e7ab0eb8874e9fdab0e',
            title: 'Binance Will List RWUSD and Introduce RWUSD Zero Trading Fee Promotion',
            releaseDate: 1791862201158,
          },
        ],
      },
    ],
  },
}

const SPEC = {
  url: 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1',
  itemsPath: 'data.catalogs.0.articles',
  idPath: 'id',
  titlePath: 'title',
  urlTemplate: 'https://www.binance.com/en/support/announcement/{code}',
}

// ── pickPath ───────────────────────────────────────────────────────────
test('pickPath：点路径穿透对象与数组索引', () => {
  assert.equal(pickPath(BINANCE, 'code'), '000000')
  assert.equal(pickPath(BINANCE, 'data.catalogs.0.catalogName'), 'New Cryptocurrency Listing')
  const arr = pickPath(BINANCE, 'data.catalogs.0.articles')
  assert.ok(Array.isArray(arr))
  assert.equal(arr.length, 2)
})

test('pickPath：路径取不到一律 undefined（不抛——路径是配置，配错要被读数看见）', () => {
  assert.equal(pickPath(BINANCE, 'nope'), undefined)
  assert.equal(pickPath(BINANCE, 'data.catalogs.5.articles'), undefined)
  assert.equal(pickPath(BINANCE, 'data.catalogs.0.articles.99'), undefined)
  assert.equal(pickPath(BINANCE, 'code.deeper'), undefined, '标量上继续下钻必须是 undefined 而不是崩')
  assert.equal(pickPath(null, 'a'), undefined)
  assert.equal(pickPath(BINANCE, ''), undefined)
})

// ── renderTemplate ─────────────────────────────────────────────────────
test('renderTemplate：字段齐全时正常替换', () => {
  assert.equal(renderTemplate('https://x/{code}', { code: 'abc' }), 'https://x/abc')
})

test('★ renderTemplate：任一字段缺失 ⇒ null（宁可不产这条，也不产残缺 URL）', () => {
  // 残缺 URL 会进快照、污染增量判据，而且看起来像「抓到了」——比不产更坏
  assert.equal(renderTemplate('https://x/{code}', {}), null)
  assert.equal(renderTemplate('https://x/{code}', { code: '' }), null)
  assert.equal(renderTemplate('https://x/{a}/{b}', { a: '1' }), null)
})

// ── mapApiItems ────────────────────────────────────────────────────────
test('★ mapApiItems：真实币安响应 → 2 条候选（URL 由模板构造）', () => {
  const r = mapApiItems(BINANCE, SPEC)
  assert.equal(r.items.length, 2)
  assert.equal(r.skipped, 0)
  assert.deepEqual(r.errors, [])
  assert.equal(r.items[0].url, 'https://www.binance.com/en/support/announcement/e52ef13311eb4e1a96f07099152e61d5')
  assert.ok(r.items[0].title?.includes('bStocks'))
  assert.equal(r.items[0].source, 'api', 'source 必须标注通道（与 crawl/arxiv 并列，事后可分辨）')
})

test('★ 尸体样本：itemsPath 配错 ⇒ 响亮报错，不是静默空', () => {
  // 「0 条」与「路径配错」是两件事——若这里静默返回空，我会读成「源没新数据」
  const r = mapApiItems(BINANCE, { ...SPEC, itemsPath: 'data.catalogs.0.wrong' })
  assert.equal(r.items.length, 0)
  assert.equal(r.errors.length, 1)
  assert.ok(r.errors[0].includes('itemsPath 取不到'))
  assert.ok(r.errors[0].includes('wrong'), '错误必须带上配错的路径本身（否则不知道改哪）')
})

test('★ 尸体样本：itemsPath 指向非数组 ⇒ 明确报错（含实际类型）', () => {
  const r = mapApiItems(BINANCE, { ...SPEC, itemsPath: 'data.catalogs.0.catalogName' })
  assert.equal(r.items.length, 0)
  assert.ok(r.errors[0].includes('不是数组'))
  assert.ok(r.errors[0].includes('string'), '要报出实际类型，否则不知道响应形状变了')
})

test('★ 模板字段缺失的条目被跳过并计数（不产残缺 URL）', () => {
  const json = { rows: [{ id: 1, code: 'a', title: 'x' }, { id: 2, title: 'no code' }] }
  const r = mapApiItems(json, { ...SPEC, itemsPath: 'rows' })
  assert.equal(r.items.length, 1)
  assert.equal(r.skipped, 1)
  assert.ok(r.notes.some((e) => e.includes('跳过 1/2')), '跳过必须计数（不许静默丢）')
  assert.deepEqual(
    r.errors,
    [],
    '跳过是数据形状问题不是源故障——混进 errors 会让「每轮跳 2 条」被读成「源一直在坏」',
  )
})

test('无 urlTemplate 时用 idPath 字段当 URL（缺省 id）', () => {
  const json = { rows: [{ id: 'https://a.b/1', title: 't1' }, { title: 'no id' }] }
  const r = mapApiItems(json, { url: 'x', itemsPath: 'rows' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].url, 'https://a.b/1')
  assert.equal(r.skipped, 1)
})

test('数组含非对象项 ⇒ 跳过计数（归一形状，不直接取字段——§5.24）', () => {
  const json = { rows: [null, 'str', 42, { id: 'ok' }] }
  const r = mapApiItems(json, { url: 'x', itemsPath: 'rows' })
  assert.equal(r.items.length, 1)
  assert.equal(r.skipped, 3)
})

test('titlePath 缺省为 title；自定义 titlePath 生效', () => {
  const json = { rows: [{ id: 'u1', name: 'N1', title: 'T1' }] }
  const a = mapApiItems(json, { url: 'x', itemsPath: 'rows' })
  assert.equal(a.items[0].title, 'T1')
  const b = mapApiItems(json, { url: 'x', itemsPath: 'rows', titlePath: 'name' })
  assert.equal(b.items[0].title, 'N1')
})

test('条目无标题时不产 title 字段（而不是空串）', () => {
  const json = { rows: [{ id: 'u1' }] }
  const r = mapApiItems(json, { url: 'x', itemsPath: 'rows' })
  assert.equal('title' in r.items[0], false)
})
