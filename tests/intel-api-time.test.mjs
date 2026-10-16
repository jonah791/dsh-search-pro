/**
 * 情报·源侧发布时间测试（纯函数，零网络）。
 *
 * 存在理由（2026-10-17 线上实测抓出）：两个 api 源**本来就有**发布时间字段
 * （币安 `releaseDate` / OKX `pTime`），而我只记了 `foundAt`（我的扫描时刻）⇒
 * 首扫把 **16–22 天跨度**的条目全报成「新」——「新发布」与「新发现」被混为一谈，
 * 而推送判据里写着「且有时效性」却**无从计算**。
 *
 * 本文件锁四件事：① 四种时间形态都能解析（真实语料锚）② 解析不出**不猜**
 * ③ 时间字段名配错要**响亮**（不报会被读成「这批公告没有发布时间」）
 * ④ 存量回填幂等（diffNew 按指纹去重 ⇒ 已报过的条目永远不会带上新字段）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseApiTime, mapApiItems } from '../lib/intel-api.js'
import { ageLabel, ageHours, pickBackfill } from '../lib/intel.js'

// ── 真实语料锚（2026-10-17 线上实抓）──────────────────────────────────────
// 币安 `releaseDate: 1791948608368`（毫秒 number）  ⇒ 2026-10-14T03:30:08.368Z
// OKX  `pTime: "1792152012457"`（毫秒**字符串**）    ⇒ 2026-10-16T12:00:12.457Z
const BNB_MS = 1791948608368
const OKX_MS_STR = '1792152012457'

test('★ 真实语料：币安 releaseDate（毫秒 number）⇒ 正确 ISO', () => {
  const iso = parseApiTime(BNB_MS)
  assert.equal(iso, '2026-10-14T03:30:08.368Z')
  // 往返一致：判据不依赖我手算的锚是否准
  assert.equal(Date.parse(iso), BNB_MS)
  // 区分力：若实现把毫秒数当**秒**解释，日期会跑到公元 5 万年外
  assert.ok(iso.startsWith('2026-'), `量级判据失效：${iso}`)
})

test('★ 真实语料：OKX pTime（毫秒**字符串**）⇒ 同样解析', () => {
  const iso = parseApiTime(OKX_MS_STR)
  assert.equal(Date.parse(iso), Number(OKX_MS_STR))
  assert.ok(iso.startsWith('2026-10-16T12:00'), `期望 12:00 锚，实际 ${iso}`)
})

test('秒级时间戳也认（量级判据的另一侧）', () => {
  const sec = Math.floor(BNB_MS / 1000)
  const iso = parseApiTime(sec)
  // ⚠ 秒级输入**结构上不含**毫秒 ⇒ 只能给秒精度。要求它与毫秒版给**完全相同**的 ISO
  // 是「判据比对象严」（初版测试就是这么写错的——把精度损失读成了实现缺陷）。
  assert.equal(iso, '2026-10-14T03:30:08.000Z')
  // 真正该锁的是：两者落在**同一秒**内 ⇒ 量级判据没把它当毫秒/微秒解释
  assert.equal(Math.floor(Date.parse(iso) / 1000), sec)
  assert.equal(Math.floor(Date.parse(parseApiTime(BNB_MS)) / 1000), sec)
})

test('ISO / 日期串直接解析', () => {
  assert.equal(parseApiTime('2026-10-14T03:30:08.368Z'), '2026-10-14T03:30:08.368Z')
  assert.equal(parseApiTime('2026-10-14 03:30:00'), new Date('2026-10-14 03:30:00').toISOString())
})

test('★ 尸体样本：解析不出的一律 undefined（不猜——编个时间会让时效判据建在假数上）', () => {
  for (const bad of ['', '   ', 'abc', 'not-a-date', null, undefined, 0, -1, 123, {}, [], true, NaN, '123']) {
    assert.equal(parseApiTime(bad), undefined, `不该解析出时间：${JSON.stringify(bad)}`)
  }
  // 量级不够的数字：既不是合法秒也不是合法毫秒。有意取严——
  // 宁可显示「时间未知」，也不显示 1970 年（那看起来和真时间一模一样）
  assert.equal(parseApiTime(999_999_999), undefined)
})

test('★ mapApiItems：配了 timePath ⇒ 条目带 publishedAt（真实响应形状）', () => {
  const json = {
    data: {
      catalogs: [
        {
          articles: [
            { id: 1, code: 'abc', title: 'A', releaseDate: BNB_MS },
            { id: 2, code: 'def', title: 'B', releaseDate: BNB_MS + 3600_000 },
          ],
        },
      ],
    },
  }
  const r = mapApiItems(json, {
    url: 'https://x',
    itemsPath: 'data.catalogs.0.articles',
    urlTemplate: 'https://x/{code}',
    timePath: 'releaseDate',
  })
  assert.equal(r.items.length, 2)
  assert.equal(r.items[0].publishedAt, '2026-10-14T03:30:08.368Z')
  assert.equal(r.items[1].publishedAt, '2026-10-14T04:30:08.368Z')
  assert.equal(r.errors.length, 0)
  assert.equal(r.notes.length, 0, '全部解析成功时不该产噪音')
})

test('★ 尸体样本：timePath 指向不存在的字段 ⇒ 无 publishedAt 且 notes 响亮', () => {
  const json = { data: { catalogs: [{ articles: [{ id: 1, code: 'a', title: 'A' }] }] } }
  const r = mapApiItems(json, {
    url: 'https://x',
    itemsPath: 'data.catalogs.0.articles',
    urlTemplate: 'https://x/{code}',
    timePath: 'wrongField',
  })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].publishedAt, undefined)
  // 必须响亮：不报的话「源改了字段名」会被读成「这批公告没有发布时间」
  assert.equal(r.notes.length, 1)
  assert.match(r.notes[0], /时间解析失败 1\/1/)
})

test('★ 不配 timePath ⇒ 不产 publishedAt（缺省不是「现在」）', () => {
  const json = { data: { catalogs: [{ articles: [{ id: 1, code: 'a', title: 'A', releaseDate: BNB_MS }] }] } }
  const r = mapApiItems(json, {
    url: 'https://x',
    itemsPath: 'data.catalogs.0.articles',
    urlTemplate: 'https://x/{code}',
  })
  // 响应里有 releaseDate，但 spec 没配 ⇒ 不猜它
  assert.equal(r.items[0].publishedAt, undefined)
  // 没配就不该报「解析失败」——那是无中生有的噪音（源本来就没承诺给时间）
  assert.equal(r.notes.length, 0)
})

test('★ ageLabel：时间未知 ≠ 刚发布（分档 + 未来显形）', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  const at = (h) => new Date(now - h * 3600_000).toISOString()
  assert.equal(ageLabel(undefined, now), '时间未知')
  assert.equal(ageLabel('not-a-date', now), '时间未知')
  assert.equal(ageLabel(at(6.09), now), '6.1h 前')
  assert.equal(ageLabel(at(62.6), now), '2.6d 前')
  // 未来时间**显形**（源选错字段/时区错时看得见，而不是静默显示成「0h 前」）
  assert.match(ageLabel(at(-3), now), /^未来 3\.0h$/)
  assert.equal(ageHours(undefined, now), undefined)
  assert.equal(ageHours(at(1), now), 1)
})

test('★ pickBackfill：只补「库里有、缺字段、本轮拿到时间」的条目（幂等）', () => {
  const known = [
    { id: 'https://x/a', targetId: 't', url: 'https://x/a', kind: 'api', foundAt: 'f', status: 'new' },
    {
      id: 'https://x/b',
      targetId: 't',
      url: 'https://x/b',
      kind: 'api',
      foundAt: 'f',
      status: 'new',
      publishedAt: '2026-01-01T00:00:00.000Z',
    },
  ]
  const found = [
    { url: 'https://x/a', publishedAt: '2026-10-14T03:30:08.368Z' }, // 缺 ⇒ 补
    { url: 'https://x/b', publishedAt: '2026-10-16T00:00:00.000Z' }, // 已有 ⇒ 不动（幂等）
    { url: 'https://x/c', publishedAt: '2026-10-16T00:00:00.000Z' }, // 不在库 ⇒ 不补
    { url: 'https://x/d' }, // 本轮没拿到时间 ⇒ 不补
  ]
  assert.deepEqual(pickBackfill(found, known), [{ id: 'https://x/a', publishedAt: '2026-10-14T03:30:08.368Z' }])
  // 幂等：对补完的库再跑一次 ⇒ 空（否则每轮都会重复 append，污染事件流）
  const after = [...known, { ...known[0], publishedAt: '2026-10-14T03:30:08.368Z' }]
  assert.deepEqual(pickBackfill(found, after), [])
})
