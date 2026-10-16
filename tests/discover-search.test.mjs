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
  buildSearchUrl, looksLikeSearchResults, extractSearchForms, formToProbeUrl,
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

// ── 从页面读搜索表单（不猜路径 · 2026-10-16 实测驱动）────────────────────

test('extractSearchForms：读出 GET 搜索表单的 action 与 input name', () => {
  const html = '<form action="/search" method="get"><input type="text" name="q" placeholder="搜索..."><input type="submit" value="搜"></form>'
  const forms = extractSearchForms(html, 'https://x.edu.cn/')
  assert.equal(forms.length, 1)
  assert.equal(forms[0].action, 'https://x.edu.cn/search')
  assert.equal(forms[0].method, 'get')
  assert.deepEqual(forms[0].inputs, ['q'])
  assert.equal(forms[0].likely, true, 'placeholder 含「搜索」⇒ likely')
  assert.ok(forms[0].basis.includes('搜索'), '依据要可复核')
})

test('★ extractSearchForms：POST 表单标出但**不产生 GET 探测 URL**（论文的结构性边界）', () => {
  const html = '<form action="/s" method="post"><input type="text" name="kw" placeholder="检索"></form>'
  const forms = extractSearchForms(html, 'https://x.edu.cn/')
  assert.equal(forms[0].method, 'post')
  assert.equal(formToProbeUrl(forms[0], '睡眠'), null, 'POST 不许拼成 GET URL（只有 GET 可索引）')
})

test('extractSearchForms：无文本输入框的表单被跳过（登录/隐藏域不可能是搜索）', () => {
  const html = '<form action="/login"><input type="password" name="pw"><input type="hidden" name="t"></form>'
  assert.deepEqual(extractSearchForms(html, 'https://x.edu.cn/'), [])
})

test('extractSearchForms：空 action ⇒ 用页面自身 URL；相对 action 被绝对化', () => {
  const a = extractSearchForms('<form><input type="text" name="q"></form>', 'https://x.edu.cn/p')
  assert.equal(a[0].action, 'https://x.edu.cn/p')
  const b = extractSearchForms('<form action="s?"><input type="text" name="q"></form>', 'https://x.edu.cn/dir/p')
  assert.equal(b[0].action, 'https://x.edu.cn/dir/s?')
})

test('extractSearchForms：无搜索语义词时 likely=false，但**仍报出**（不丢证据）', () => {
  const forms = extractSearchForms('<form action="/find"><input type="text" name="a"></form>', 'https://x/')
  assert.equal(forms[0].likely, false)
  assert.ok(forms[0].basis.includes('无搜索语义词'))
})

test('formToProbeUrl：查询词被 URL 编码进第一个输入框名', () => {
  const forms = extractSearchForms('<form action="/s" method="get"><input type="text" name="kw"></form>', 'https://x/')
  const u = formToProbeUrl(forms[0], '睡眠 研究')
  // ⚠ URLSearchParams 按 form-urlencoded 规范把**空格编码成 `+`**（不是 %20）——
  // 两者在 query string 里都合法，实现用的是标准 API ⇒ 断言照实际规范写（判据别比实现严）。
  assert.equal(u, 'https://x/s?kw=' + encodeURIComponent('睡眠 研究').replace(/%20/g, '+'))
})

test('formToProbeUrl：退化输入（无 inputs）返回 null，不抛', () => {
  assert.equal(formToProbeUrl({ action: 'https://x/', method: 'get', inputs: [], likely: true, basis: '' }, 'a'), null)
})
