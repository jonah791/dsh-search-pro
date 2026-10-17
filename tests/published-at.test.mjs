/**
 * site 类时间提取单测（2026-10-17 · 给 site 类情报源补时效维）。
 *
 * 背景：`intel_watch` 的 `timePath` 只对 `kind=api` 生效，而 `discoverSite` 返回的
 * `pages`/`attachments` 是**纯 URL 字符串** ⇒ site 类条目一律「时间未知」（实测 6/6），
 * 时效维度对它完全失效。本模块从 HTML（meta / `<time>`）与 URL 路径抽时间。
 *
 * ★ 尸体样本纪律（本文件的核心）：判据要证明它**会拦**，不只是「命中时对」——
 *   ① 无结构化信号 ⇒ 必须 undefined（不从正文日期猜，那是误报温床）
 *   ② 不存在的日期（2026-02-30）⇒ 必须 undefined（JS 原生 Date 会静默滚到 3-02）
 *   ③ 早于 1990 / 未来超 1 天 ⇒ 必须 undefined（网页时间戳的常见脏值）
 *   ④ URL 里的任意数字 / **仅年份段** ⇒ 不得当日期（只认**完整**日期段：年+月+日）
 *
 * 运行：node --test tests/published-at.test.mjs（导入编译产物 lib/*.js）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPublishedAt, extractDateFromUrl, timeForAttachment } from '../lib/published-at.js'

// ---------- extractPublishedAt：结构化信号 ----------

test('A120 extractPublishedAt：article:published_time 命中（from=meta）', () => {
  const html = '<html><head><meta property="article:published_time" content="2026-10-17T08:30:00+08:00"></head><body>x</body></html>'
  const r = extractPublishedAt(html)
  assert.equal(r?.from, 'meta')
  assert.equal(r?.at, '2026-10-17T00:30:00.000Z', '带时区的时刻应归一到 UTC')
})

test('A121 优先级：article:published_time 胜过 pubdate / date', () => {
  const html = [
    '<meta name="pubdate" content="2019-01-01">',
    '<meta name="date" content="2020-01-01">',
    '<meta property="article:published_time" content="2026-10-17">',
  ].join('\n')
  const r = extractPublishedAt(html)
  assert.equal(r?.at, '2026-10-17T00:00:00.000Z', '应取最可信的那个')
})

test('A122 中文日期与斜杠格式（meta content 里）', () => {
  assert.equal(extractPublishedAt('<meta name="date" content="2026年10月17日">')?.at, '2026-10-17T00:00:00.000Z')
  assert.equal(extractPublishedAt('<meta name="date" content="2026/10/17">')?.at, '2026-10-17T00:00:00.000Z')
})

test('A123 `<time datetime>` 兜底（from=time-tag）', () => {
  const html = '<article><time datetime="2026-10-16T22:00:00Z">昨天</time></article>'
  const r = extractPublishedAt(html)
  assert.equal(r?.from, 'time-tag')
  assert.equal(r?.at, '2026-10-16T22:00:00.000Z')
})

// ---------- ★ 尸体样本 ----------

test('A124 ★尸体：无任何结构化信号 ⇒ undefined（不从正文日期猜）', () => {
  // 正文里出现的日期与发布时间无关（引用、历史事件、表格数据）——猜它必然误报
  const html = '<html><body><p>根据 2019-03-05 的会议纪要，本次招标……</p><p>公告日期：2026-10-17</p></body></html>'
  assert.equal(extractPublishedAt(html), undefined, '没有 meta/time 标签就必须如实返回「不知道」')
  assert.equal(extractPublishedAt(''), undefined)
  assert.equal(extractPublishedAt('<html></html>'), undefined)
})

test('A125 ★尸体：不存在的日期（2026-02-30）必须被拦', () => {
  // JS 原生 Date 会静默滚到 3-02 ⇒ 若不拦，页面里一个手误日期就会变成一条假时效
  assert.equal(extractPublishedAt('<meta name="date" content="2026-02-30">'), undefined)
  assert.equal(extractPublishedAt('<meta name="date" content="2026-13-01">'), undefined)
  assert.equal(extractPublishedAt('<meta name="date" content="2026-04-31">'), undefined)
})

test('A126 ★尸体：脏值边界（早于 1990 / 未来超 1 天）⇒ undefined', () => {
  assert.equal(extractPublishedAt('<meta name="date" content="1970-01-01">'), undefined)
  assert.equal(extractPublishedAt('<meta name="date" content="2099-01-01">'), undefined)
  assert.equal(extractPublishedAt('<meta name="date" content="not-a-date">'), undefined)
  assert.equal(extractPublishedAt('<meta name="date" content="">'), undefined)
})

// ---------- extractDateFromUrl ----------

test('A127 extractDateFromUrl：完整日期段（from=url）', () => {
  assert.equal(extractDateFromUrl('https://x.gov.cn/2026/10/17/notice.html')?.at, '2026-10-17T00:00:00.000Z')
  assert.equal(extractDateFromUrl('https://x.gov.cn/2026-10-17/a.html')?.at, '2026-10-17T00:00:00.000Z')
  assert.equal(extractDateFromUrl('https://x.gov.cn/2026/10/17/a.html')?.from, 'url')
})

test('A128 ★尸体：仅年份段不得当发布时间（线上取证改判）', () => {
  // 2026-10-17 线上取证：ccgp 三个附件命中**全是年份段形态**，补成 01-01 是假精度——
  // 目录年份常是建目录那年，于是 /2026/xxx.zip（可能今天刚发）被断言成十个月前，
  // 而 index.ts 按 `publishedAt ?? foundAt` 排序 ⇒ 恰好把新鲜情报降级。故一律不认。
  assert.equal(extractDateFromUrl('https://download.ccgp.gov.cn/2018/tousushufanben.zip'), undefined)
  assert.equal(extractDateFromUrl('https://download.ccgp.gov.cn/2026/68714beb-7db8.zip'), undefined, '当年目录同样不认——否则假旧')
  assert.equal(extractDateFromUrl('https://x.gov.cn/2026/notice.html'), undefined)
})

test('A129 ★尸体：URL 里的任意数字不得当日期', () => {
  assert.equal(extractDateFromUrl('https://x.gov.cn/article/12345.html'), undefined)
  assert.equal(extractDateFromUrl('https://x.gov.cn/a/999/abc.html'), undefined)
  assert.equal(extractDateFromUrl('https://x.gov.cn/c26758a286061/page.htm'), undefined)
  assert.equal(extractDateFromUrl('not a url'), undefined)
})

// ---------- timeForAttachment ----------

test('A130 timeForAttachment：优先自身 URL 完整日期，否则继承页面（来源标 page）', () => {
  const pageTime = { at: '2026-10-17T00:00:00.000Z', from: 'meta' }

  const own = timeForAttachment('https://x.gov.cn/2019/05/06/a.docx', pageTime)
  assert.equal(own?.from, 'url', '自身 URL 有**完整日期**时用它（更具体）')
  assert.equal(own?.at, '2019-05-06T00:00:00.000Z')

  // 自身只有年份段 ⇒ 不认，**退到继承**（不是「有就用」——那会把假精度优先于真代理）
  const yearOnly = timeForAttachment('https://x.gov.cn/2019/a.docx', pageTime)
  assert.equal(yearOnly?.from, 'page', '年份段不算自身日期，应退到页面继承')
  assert.equal(yearOnly?.at, '2026-10-17T00:00:00.000Z')

  const inherited = timeForAttachment('https://x.gov.cn/_upload/a.docx', pageTime)
  assert.equal(inherited?.from, 'page')
  assert.equal(inherited?.at, '2026-10-17T00:00:00.000Z')

  // ★尸体：两者都没有 ⇒ undefined（不得编造）
  assert.equal(timeForAttachment('https://x.gov.cn/_upload/a.docx', undefined), undefined)
  assert.equal(timeForAttachment('https://x.gov.cn/2019/a.docx', undefined), undefined, '年份段 + 无页面时间 ⇒ 仍须 undefined')
})
