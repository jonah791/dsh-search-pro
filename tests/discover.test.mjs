/**
 * discover 纯函数层测试。
 *
 * 判据纪律（§5.9 规则 2）：每个「防线」都要有尸体样本证明它会拦——
 * 恒为空的输出不是证据。本文件里的尸体样本：
 *   · Common Crawl 的 504 HTML 页（必须报 error，不许静默空手）
 *   · 源侧 {"error": "..."} 行（必须透出）
 *   · 非 JSON 响应（wayback/crtsh）
 *   · 伪装成 sitemap 的 HTML 页
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  extOf,
  isAttachment,
  isJunk,
  parseCommonCrawl,
  parseWaybackCdx,
  parseCrtsh,
  parseOtx,
  extractDiscoveryLinks,
  normalizeDiscovered,
  discoverStats,
} from '../lib/discover.js'

import { extractPagination, parseSitemapText, columnKey, isContentPage, assessCoverage } from '../lib/discover-site.js'

// ── extOf ──────────────────────────────────────────────────────────────
test('extOf 取小写扩展名并忽略 query/hash', () => {
  assert.equal(extOf('https://a.b/c/report.PDF'), 'pdf')
  assert.equal(extOf('https://a.b/c/doc.docx?x=1'), 'docx')
  assert.equal(extOf('https://a.b/c/f.htm#top'), 'htm')
})

test('extOf 无扩展名/隐藏文件/末尾点 都返回空串', () => {
  assert.equal(extOf('https://a.b/list'), '')
  assert.equal(extOf('https://a.b/path/'), '')
  assert.equal(extOf('https://a.b/.hidden'), '')
  assert.equal(extOf('https://a.b/trailing.'), '')
})

test('extOf 超长后缀不当作扩展名（防把 hash 段误判）', () => {
  assert.equal(extOf('https://a.b/x.abcdefghijkl'), '')
})

// ── isAttachment / isJunk ──────────────────────────────────────────────
test('isAttachment 认文档类附件', () => {
  for (const u of ['a.pdf', 'a.docx', 'a.xlsx', 'a.pptx', 'a.csv', 'a.zip']) {
    assert.equal(isAttachment('https://x.y/' + u), true, u)
  }
})

test('isAttachment 不认网页与静态资源', () => {
  for (const u of ['a.htm', 'a.html', 'a.jpg', 'a.css', 'a.js', 'list']) {
    assert.equal(isAttachment('https://x.y/' + u), false, u)
  }
})

test('isJunk 只丢媒体与前端资源，不丢文档', () => {
  assert.equal(isJunk('https://x.y/a.jpg'), true)
  assert.equal(isJunk('https://x.y/a.css'), true)
  assert.equal(isJunk('https://x.y/a.pdf'), false)
  assert.equal(isJunk('https://x.y/list.htm'), false)
})

// ── parseCommonCrawl ───────────────────────────────────────────────────
test('parseCommonCrawl 正常 JSONL：每行一条，元数据带出', () => {
  const text = [
    '{"url":"https://www.sues.edu.cn/","status":"200","mime":"text/html","timestamp":"20260904131850"}',
    '{"url":"https://www.sues.edu.cn/a.pdf","status":"200","mime":"application/pdf"}',
    '',
  ].join('\n')
  const r = parseCommonCrawl(text)
  assert.equal(r.error, undefined)
  assert.equal(r.urls.length, 2)
  assert.equal(r.urls[0].url, 'https://www.sues.edu.cn/')
  assert.equal(r.urls[0].source, 'commoncrawl')
  assert.equal(r.urls[0].status, '200')
  assert.equal(r.urls[0].ts, '20260904131850')
  assert.equal(r.urls[1].mime, 'application/pdf')
})

test('尸体样本：CC 返回 504 HTML 必须报 error，不许静默空手', () => {
  const html = '<html>\n<head><title>504 Gateway Time-out</title></head>\n<body>\n\n</body>\n</html>'
  const r = parseCommonCrawl(html)
  assert.ok(r.error, '504 页必须产生 error')
  assert.equal(r.urls.length, 0)
})

test('尸体样本：CC 源侧 error 行必须透出', () => {
  const r = parseCommonCrawl('{"error":"No Captures found for: x"}')
  assert.match(String(r.error), /No Captures/)
})

test('空响应是空，不是错误（空与失败必须分型）', () => {
  const r = parseCommonCrawl('')
  assert.equal(r.error, undefined)
  assert.equal(r.urls.length, 0)
})

test('缺 url 字段的行被跳过，不产生空 URL 条目', () => {
  const r = parseCommonCrawl('{"status":"200"}\n{"url":"https://ok.x/"}')
  assert.equal(r.urls.length, 1)
  assert.equal(r.urls[0].url, 'https://ok.x/')
})

// ── parseWaybackCdx ────────────────────────────────────────────────────
test('parseWaybackCdx 按表头索引取值（不靠位置硬编码）', () => {
  const text = JSON.stringify([
    ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode'],
    ['cn,edu,sues)/', '20240101000000', 'https://www.sues.edu.cn/', 'text/html', '200'],
  ])
  const r = parseWaybackCdx(text)
  assert.equal(r.urls.length, 1)
  assert.equal(r.urls[0].url, 'https://www.sues.edu.cn/')
  assert.equal(r.urls[0].ts, '20240101000000')
  assert.equal(r.urls[0].source, 'wayback')
})

test('parseWaybackCdx 表头缺列时不崩，缺的字段为 undefined', () => {
  const text = JSON.stringify([['original'], ['https://a.b/c']])
  const r = parseWaybackCdx(text)
  assert.equal(r.urls.length, 1)
  assert.equal(r.urls[0].ts, undefined)
  assert.equal(r.urls[0].status, undefined)
})

test('尸体样本：wayback 返回非 JSON（被墙时的网关页）必须报 error', () => {
  const r = parseWaybackCdx('<html>blocked</html>')
  assert.ok(r.error)
  assert.equal(r.urls.length, 0)
})

test('parseWaybackCdx 空数组是空，不是错误', () => {
  const r = parseWaybackCdx('[]')
  assert.equal(r.error, undefined)
  assert.equal(r.urls.length, 0)
})

// ── parseCrtsh ─────────────────────────────────────────────────────────
test('parseCrtsh 拆多行 name_value 并去掉通配符项', () => {
  const text = JSON.stringify([
    { name_value: '*.sues.edu.cn\nsues.edu.cn' },
    { name_value: 'jwc.sues.edu.cn' },
  ])
  const r = parseCrtsh(text)
  const hosts = r.urls.map((u) => u.url)
  assert.equal(hosts.includes('https://jwc.sues.edu.cn/'), true)
  assert.equal(hosts.includes('https://sues.edu.cn/'), true)
  assert.equal(hosts.some((h) => h.includes('*')), false, '通配符不应产生条目')
  assert.equal(r.urls.length, 2, '通配符被丢弃、sues.edu.cn 去重')
})

test('尸体样本：crtsh 返回非数组必须报 error', () => {
  const r = parseCrtsh('{"detail":"bad"}')
  assert.ok(r.error)
})

// ── parseOtx ───────────────────────────────────────────────────────────
test('尸体样本：OTX 匿名受限响应（无 passive_dns）必须报 error', () => {
  const r = parseOtx('{"detail":"Anonymous access to this endpoint is limited."}')
  assert.ok(r.error)
  assert.equal(r.urls.length, 0)
})

test('parseOtx 正常响应取 hostname 并去重', () => {
  const text = JSON.stringify({ passive_dns: [{ hostname: 'a.sues.edu.cn' }, { hostname: 'a.sues.edu.cn' }, { hostname: 'b.sues.edu.cn' }] })
  const r = parseOtx(text)
  assert.equal(r.urls.length, 2)
  assert.equal(r.urls[0].source, 'otx')
})

// ── extractDiscoveryLinks ──────────────────────────────────────────────
test('extractDiscoveryLinks 分三类抽：sitemap / feed / 附件', () => {
  const html = `
    <a href="/sitemap.xml">s</a>
    <a href="/feed.xml">f</a>
    <a href="/rss">r</a>
    <a href="/files/notice.pdf">p</a>
    <a href="/files/data.xlsx">x</a>
    <a href="/img/logo.png">i</a>
    <a href="https://other.com/up.docx">abs</a>
    <script src="/js/app.js"></script>`
  const r = extractDiscoveryLinks(html, 'https://www.sues.edu.cn/a/b.htm')
  assert.equal(r.sitemaps.length, 1)
  assert.equal(r.sitemaps[0], 'https://www.sues.edu.cn/sitemap.xml')
  assert.equal(r.feeds.length, 2)
  assert.equal(r.attachments.length, 3, '含跨域附件；png/js 不算')
})

test('回归锁：feed.xml / atom.xml 必须判为 feed，不被 sitemap 的 .xml 宽判据吞掉', () => {
  const r = extractDiscoveryLinks(
    '<a href="/feed.xml">f</a><a href="/atom.xml">a</a><a href="/sitemap.xml">s</a>',
    'https://a.b/',
  )
  assert.equal(r.feeds.length, 2, 'feed.xml 与 atom.xml 都是 feed')
  assert.equal(r.sitemaps.length, 1, '只有 sitemap.xml 是 sitemap')
})

test('extractDiscoveryLinks 忽略 javascript:/data: 链接且不崩', () => {  const html = `<a href="javascript:void(0)">a</a><a href="data:text/plain,x">b</a><a href="/x.pdf">c</a>`
  const r = extractDiscoveryLinks(html, 'https://a.b/')
  assert.equal(r.attachments.length, 1)
})

test('extractDiscoveryLinks 对畸形 base 不抛错', () => {
  const r = extractDiscoveryLinks('<a href="/x.pdf">a</a>', 'not-a-url')
  assert.equal(r.attachments.length, 0)
})

// ── normalizeDiscovered ────────────────────────────────────────────────
test('normalizeDiscovered 同 URL 合并来源并补齐元数据', () => {
  const items = [
    { url: 'https://a.b/x', source: 'commoncrawl' },
    { url: 'https://a.b/x', source: 'wayback', status: '200' },
    { url: 'https://a.b/y', source: 'crtsh' },
  ]
  const out = normalizeDiscovered(items)
  assert.equal(out.length, 2)
  const x = out.find((o) => o.url === 'https://a.b/x')
  assert.deepEqual(x.sources, ['commoncrawl', 'wayback'])
  assert.equal(x.status, '200', '后来源的元数据应补齐')
})

test('normalizeDiscovered 剥离 hash 但不丢 query', () => {
  const out = normalizeDiscovered([
    { url: 'https://a.b/x?id=1#frag', source: 's' },
    { url: 'https://a.b/x?id=1', source: 's' },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].url, 'https://a.b/x?id=1')
})

test('normalizeDiscovered 非法 URL 原样保留（不静默丢）', () => {
  const out = normalizeDiscovered([{ url: 'not a url', source: 's' }])
  assert.equal(out.length, 1)
  assert.equal(out[0].url, 'not a url')
})

// ── discoverStats ──────────────────────────────────────────────────────
test('discoverStats 现算各源计数与附件数', () => {
  const items = [
    { url: 'https://a.b/1', source: 'cc' },
    { url: 'https://a.b/2.pdf', source: 'cc' },
    { url: 'https://a.b/3', source: 'crtsh' },
  ]
  const s = discoverStats(items, { wayback: 'blocked' })
  assert.equal(s.total, 3)
  assert.equal(s.attachments, 1)
  assert.equal(s.perSource.cc, 2)
  assert.equal(s.errorCount, 1)
})

// ── extractPagination ──────────────────────────────────────────────────
test('extractPagination 认「下一页」与 list2.htm 形态', () => {
  const html = `<a href="list2.htm">下一页</a><a href="/x/list3.htm">3</a><a href="/other.htm">随便</a>`
  const r = extractPagination(html, 'https://a.b/x/list.htm')
  assert.equal(r.includes('https://a.b/x/list2.htm'), true)
  assert.equal(r.includes('https://a.b/x/list3.htm'), true)
  assert.equal(r.includes('https://a.b/other.htm'), false)
})

test('extractPagination 不把 javascript:/# 当分页', () => {
  const html = `<a href="javascript:;">下一页</a><a href="#next">next</a>`
  assert.equal(extractPagination(html, 'https://a.b/').length, 0)
})

// ── parseSitemapText ───────────────────────────────────────────────────
test('parseSitemapText 吃 XML 形态的 <loc>', () => {
  const xml = `<?xml version="1.0"?><urlset><url><loc>https://a.b/1</loc></url><url><loc>https://a.b/2</loc></url></urlset>`
  assert.deepEqual(parseSitemapText(xml), ['https://a.b/1', 'https://a.b/2'])
})

test('parseSitemapText 回退到纯文本 URL 行', () => {
  const txt = 'https://a.b/1\n# comment\nhttps://a.b/2\n'
  assert.deepEqual(parseSitemapText(txt), ['https://a.b/1', 'https://a.b/2'])
})

test('尸体样本：伪装成 sitemap 的 HTML 页抽不出 URL', () => {
  const html = '<html><body><a href="/x">x</a></body></html>'
  assert.equal(parseSitemapText(html).length, 0)
})

// ── 离线实测抓出的两处缺陷的回归锁（2026-10-16）──────────────────────
test('回归锁：http/https 归一（Common Crawl 同页会同时给两条）', () => {
  const out = normalizeDiscovered([
    { url: 'http://www.a.b/x', source: 'commoncrawl' },
    { url: 'https://www.a.b/x', source: 'commoncrawl' },
  ])
  assert.equal(out.length, 1, '不归一会产生双份噪音')
  assert.equal(out[0].url, 'https://www.a.b/x')
})

test('回归锁：isAttachment 用 MIME 补「URL 无扩展名」的漏判', () => {
  assert.equal(isAttachment('https://a.b/download?id=7', 'application/pdf'), true)
  assert.equal(
    isAttachment('https://a.b/d?id=7', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    true,
  )
  assert.equal(isAttachment('https://a.b/page', 'text/html'), false, 'HTML 不是附件')
  assert.equal(isAttachment('https://a.b/page'), false, '无 mime 无扩展名 ⇒ 不是附件')
})

test('回归锁：站点协议文件不是附件（robots.txt 曾被误判为附件）', () => {  assert.equal(isAttachment('https://a.b/robots.txt'), false)
  assert.equal(isAttachment('https://a.b/sitemap.xml'), false)
  assert.equal(isAttachment('https://a.b/security.txt'), false)
  assert.equal(isAttachment('https://a.b/real-data.txt'), true, '普通 .txt 仍应是附件')
})

test('回归锁：discoverStats 用 mime 计附件数', () => {
  const s = discoverStats(
    [
      { url: 'https://a.b/x', source: 'cc', mime: 'application/pdf' },
      { url: 'https://a.b/y', source: 'cc', mime: 'text/html' },
    ],
    {},
  )
  assert.equal(s.attachments, 1)
})

// ── 栏目配额与内容页（2026-10-16 实测：40 页预算被单栏目分页吃光）──────────
test('columnKey 把分页归一成同一栏目（防单栏目刷屏）', () => {
  assert.equal(columnKey('https://a.b/10669/list2.htm'), 'https://a.b/10669/list.htm')
  assert.equal(columnKey('https://a.b/10669/list10.htm'), 'https://a.b/10669/list.htm')
  assert.equal(columnKey('https://a.b/10669/list.htm'), 'https://a.b/10669/list.htm')
  assert.equal(columnKey('https://a.b/x/page.htm'), 'https://a.b/x/page.htm', '非 list/index 不受影响')
})

test('isContentPage 认文章页形态（附件藏在文章页里）', () => {
  assert.equal(isContentPage('https://a.b/13/64/c278a267108/page.htm'), true)
  assert.equal(isContentPage('https://a.b/c123a456/page.htm'), true)
  assert.equal(isContentPage('https://a.b/10669/list.htm'), false)
  assert.equal(isContentPage('https://a.b/'), false)
})

// ── assessCoverage（HALT 迁移：停止判据 = 证据覆盖）──────────────────────
test('assessCoverage：sitemap+robots 两路证据 ⇒ high', () => {
  const c = assessCoverage({
    sitemapOkCount: 1, sitemapProbeCount: 5, sitemapNotFoundCount: 4,
    fetched: 30, failed: 0, maxPages: 40, maxDepth: 3, maxDepthReached: 2,
    queueRemaining: 5, pages: 30, columns: 8, attachments: 2, feeds: 0,
  })
  assert.equal(c.confidence, 'high')
  assert.ok(c.basis.some((b) => b.includes('sitemap')))
})

test('尸体样本：装置不可用 ⇒ low，且不许读成「这个站没有内容」', () => {
  const c = assessCoverage({
    robotsError: 'fetch failed', sitemapOkCount: 0, sitemapProbeCount: 5, sitemapNotFoundCount: 0,
    fetched: 0, failed: 1, maxPages: 40, maxDepth: 3, maxDepthReached: 0,
    queueRemaining: 1, pages: 0, columns: 0, attachments: 0, feeds: 0,
  })
  assert.equal(c.confidence, 'low')
  assert.ok(c.basis.some((b) => b.includes('装置不可用')))
})

test('assessCoverage：队列有剩余必须点明（是预算用尽，不是没有）', () => {
  const c = assessCoverage({
    sitemapOkCount: 0, sitemapProbeCount: 5, sitemapNotFoundCount: 5,
    fetched: 40, failed: 0, maxPages: 40, maxDepth: 3, maxDepthReached: 3,
    queueRemaining: 12, pages: 40, columns: 10, attachments: 0, feeds: 0,
  })
  assert.ok(c.gaps.some((g) => g.includes('队列仍有 12')))
})

test('assessCoverage：sitemap 全 404 说成「该站未提供」而非故障', () => {
  const c = assessCoverage({
    sitemapOkCount: 0, sitemapProbeCount: 5, sitemapNotFoundCount: 5,
    fetched: 10, failed: 0, maxPages: 40, maxDepth: 3, maxDepthReached: 1,
    queueRemaining: 0, pages: 10, columns: 3, attachments: 0, feeds: 0,
  })
  assert.ok(c.gaps.some((g) => g.includes('该站未提供 sitemap')))
})

test('assessCoverage：sitemap 候选部分是故障时不许说成「未提供」', () => {
  const c = assessCoverage({
    sitemapOkCount: 0, sitemapProbeCount: 5, sitemapNotFoundCount: 2,
    fetched: 10, failed: 0, maxPages: 40, maxDepth: 3, maxDepthReached: 1,
    queueRemaining: 0, pages: 10, columns: 3, attachments: 0, feeds: 0,
  })
  assert.ok(c.gaps.some((g) => g.includes('部分是故障')))
})

test('assessCoverage：失败率 >30% ⇒ low', () => {
  const c = assessCoverage({
    sitemapOkCount: 0, sitemapProbeCount: 5, sitemapNotFoundCount: 5,
    fetched: 6, failed: 4, maxPages: 40, maxDepth: 3, maxDepthReached: 1,
    queueRemaining: 0, pages: 6, columns: 2, attachments: 0, feeds: 0,
  })
  assert.equal(c.confidence, 'low')
})

test('assessCoverage：robots 404 是「未提供」不是「取不到」', () => {
  const c = assessCoverage({
    robotsError: 'HTTP 404 for https://a.b/robots.txt',
    sitemapOkCount: 0, sitemapProbeCount: 5, sitemapNotFoundCount: 5,
    fetched: 10, failed: 0, maxPages: 40, maxDepth: 3, maxDepthReached: 1,
    queueRemaining: 0, pages: 10, columns: 3, attachments: 0, feeds: 0,
  })
  assert.ok(c.gaps.some((g) => g.includes('未提供（404/410）')))
  assert.ok(!c.gaps.some((g) => g.includes('存在但取不到')))
})
