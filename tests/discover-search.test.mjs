/**
 * 站内搜索探测（Harnessing the Deep Web 迁移）的纯函数测试。
 *
 * 纪律：新判据必须带**尸体样本**——`looksLikeSearchResults` 的三具尸体
 * （404 页 / 首页原样 / 「无结果」页）必须全部判否；恒为「是」的判据不是判据。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SEARCH_PATH_TEMPLATES, stripTags, termsFromText, extractSeedTerms,
  buildSearchUrl, looksLikeSearchResults,
} from '../lib/discover-search.js'
import { extractSameSiteLinks } from '../lib/discover-search-fetch.js'

test('stripTags：去 script/style/注释、解实体、折叠空白', () => {
  const html = '<div><script>var x=1</script><!-- c --><style>.a{}</style><p>A&nbsp;&amp;&nbsp;B</p></div>'
  const t = stripTags(html)
  assert.equal(t.includes('var x'), false)
  assert.equal(t.includes('.a{}'), false)
  assert.equal(t.includes('c -->'), false)
  assert.equal(t, 'A & B')
})

test('termsFromText：中文切 2–4 字 n-gram，停用词被滤掉', () => {
  const terms = termsFromText('上海体育大学')
  assert.ok(terms.includes('上海'), '应有 2 字片段')
  assert.ok(terms.includes('上海体育'), '应有 4 字片段')
  assert.ok(terms.includes('体育大学'), '应覆盖全部 4 字窗口')
  assert.equal(terms.includes('的'), false, '停用词不许出现')
})

test('termsFromText：英文词保留，纯数字与停用词滤掉', () => {
  const terms = termsFromText('Alice Search 2026 the and 42')
  assert.ok(terms.includes('Alice'))
  assert.ok(terms.includes('Search'))
  assert.equal(terms.includes('2026'), false, '纯数字不是种子词')
  assert.equal(terms.includes('the'), false)
})

test('extractSeedTerms：标题权重高于链接文本', () => {
  const html = `
    <html><head><title>睡眠研究</title></head>
    <body><a href="/a">睡眠研究</a><a href="/b">其他内容</a></body></html>`
  const terms = extractSeedTerms(html, { limit: 3 })
  // 「睡眠研究」在 title（权重 3）+ 链接（权重 1）⇒ 应排第一
  assert.equal(terms[0], '睡眠研究')
})

test('extractSeedTerms：退化输入（空 HTML / 无文本）返回空数组，不抛', () => {
  assert.deepEqual(extractSeedTerms(''), [])
  assert.deepEqual(extractSeedTerms('<html><body></body></html>'), [])
})

test('buildSearchUrl：查询词被正确编码，base 尾部斜杠被归一', () => {
  const u = buildSearchUrl('https://x.edu.cn/', '/search?q={q}', '睡眠 研究')
  assert.equal(u, 'https://x.edu.cn/search?q=' + encodeURIComponent('睡眠 研究'))
})

test('SEARCH_PATH_TEMPLATES：都含 {q} 占位且都是 GET 形态（论文：只有 GET 可索引）', () => {
  assert.ok(SEARCH_PATH_TEMPLATES.length >= 5)
  for (const t of SEARCH_PATH_TEMPLATES) {
    assert.ok(t.includes('{q}'), `${t} 缺 {q}`)
    assert.ok(t.startsWith('/'), `${t} 应以 / 开头`)
  }
})

// ── ★ 三具尸体：全判否 ────────────────────────────────────────────────

test('★ 尸体①：404 错误页判否（内容过短）', () => {
  const r = looksLikeSearchResults('<html><body><h1>404 Not Found</h1></body></html>', '睡眠')
  assert.equal(r.ok, false)
  assert.ok(r.reason.length > 0, '判否必须带理由（不许静默）')
})

test('★ 尸体②：与首页几乎相同判否（查询词未生效）', () => {
  const home = '<html><body>' + '首页内容'.repeat(60) + '<ul>' + '<li>x</li>'.repeat(6) + '</ul></body></html>'
  const r = looksLikeSearchResults(home, '睡眠', home)
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('首页'), `理由应指向首页基线，实际：${r.reason}`)
})

test('★ 尸体③：「无结果」页判否（长度够但无结果结构信号）', () => {
  const html = '<html><body><h1>搜索</h1><p>' + '抱歉，未找到与您输入条件相符的内容，请更换关键词后重试。'.repeat(4) + '</p></body></html>'
  const r = looksLikeSearchResults(html, '睡眠')
  assert.equal(r.ok, false, '无结果页不许判成「有搜索接口」')
})

// ── 正样本：真实形状应判是 ───────────────────────────────────────────

test('looksLikeSearchResults：含查询词回显 + 列表项 + 分页 ⇒ 判是', () => {
  const html = '<html><body><h1>搜索结果</h1><p>共 42 条</p><ul>' +
    '<li><a href="/a">睡眠研究一</a></li>'.repeat(6) +
    '</ul><a href="?p=2">下一页</a></body></html>'
  const r = looksLikeSearchResults(html, '睡眠')
  assert.equal(r.ok, true)
  assert.ok(r.reason.includes('命中信号'), r.reason)
})

test('extractSameSiteLinks：同源过滤 + 去重 + 去锚点 + 跨域剔除', () => {
  const html = `
    <a href="/a">1</a><a href="/a#x">2</a><a href="https://www.x.edu.cn/b">3</a>
    <a href="https://evil.com/c">4</a><a href="javascript:void(0)">5</a>
    <a href="/d.pdf">6</a>`
  const links = extractSameSiteLinks(html, 'https://x.edu.cn/page', 'https://x.edu.cn/', 50)
  // ⚠ 断言修正（实测抓出）：host 归一（去 www）**只用于判同源**，返回的是**原样 URL**——
  // 归一化是 discover.js 的 normalizeDiscovered 的职责（单一真源），这里不许替它做。
  // 教训同 persisted-field-extension §判据设计 5：判据别比实现严，实现是对的。
  assert.deepEqual(links, ['https://x.edu.cn/a', 'https://www.x.edu.cn/b', 'https://x.edu.cn/d.pdf'])
})

test('extractSameSiteLinks：退化输入（非法 base / 空 HTML）返回空数组，不抛', () => {
  assert.deepEqual(extractSameSiteLinks('<a href="/a">1</a>', 'https://x/', 'not-a-url'), [])
  assert.deepEqual(extractSameSiteLinks('', 'https://x/', 'https://x/'), [])
})
