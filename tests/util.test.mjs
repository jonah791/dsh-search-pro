/**
 * util.ts 纯函数套件（离线、无网络）。
 * 覆盖：正常路径 + 失败/退化路径（空值、非法输入、编码异常）——后者是 S6 判据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripTags, htmlToText, decodeDdgUrl, decodeBingUrl, normalizeUrl, dedupe, str, num,
} from '../lib/util.js'

test('stripTags: 去 script/style 块并解码实体、折叠空白', () => {
  const html = '<script>var a=1</script><style>.x{}</style><p>Hello &amp; world</p>\n\n<i>52&nbsp;Hz</i>'
  assert.equal(stripTags(html), 'Hello & world 52 Hz')
})

test('stripTags: script 标签大小写不敏感', () => {
  assert.equal(stripTags('<SCRIPT>x</SCRIPT>keep'), 'keep')
})

test('stripTags: 退化输入（空串 / 纯标签 / 无标签）', () => {
  assert.equal(stripTags(''), '')
  assert.equal(stripTags('<div></div>'), '')
  assert.equal(stripTags('plain'), 'plain')
})

test('htmlToText: 优先 main > article > body', () => {
  assert.equal(htmlToText('<body><main>M</main><p>B</p></body>'), 'M')
  assert.equal(htmlToText('<body><article>A</article><p>B</p></body>'), 'A')
  assert.equal(htmlToText('<body><p>B</p></body>'), 'B')
})

test('htmlToText: 无结构标签时回退整体', () => {
  assert.equal(htmlToText('<p>x</p>'), 'x')
})

test('htmlToText: 超长截断并加省略号（退化：不再无限增长）', () => {
  const long = '<p>' + 'a'.repeat(50) + '</p>'
  const out = htmlToText(long, 10)
  assert.equal(out, 'a'.repeat(10) + '…')
  assert.equal(htmlToText(long, 100).endsWith('…'), false)
})

test('decodeDdgUrl: 解出 uddg 真实地址', () => {
  const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x'
  assert.equal(decodeDdgUrl(href), 'https://example.com/a?b=1')
})

test('decodeDdgUrl: 失败路径——非法百分号编码不抛，落入协议补全分支', () => {
  // decodeURIComponent('%E0%A4%A') 抛 URIError → catch 后继续走函数末尾的协议补全，
  // 于是 href 除协议外原样保留（不是「原串原样返回」，协议相对会被补成 https:）。
  const bad = '//duckduckgo.com/l/?uddg=%E0%A4%A&rut=x'
  assert.equal(decodeDdgUrl(bad), 'https://duckduckgo.com/l/?uddg=%E0%A4%A&rut=x')
  // 非协议相对 + 非法编码 ⇒ 原样返回
  const abs = 'https://duckduckgo.com/l/?uddg=%E0%A4%A'
  assert.equal(decodeDdgUrl(abs), abs)
})

test('decodeDdgUrl: 失败路径——无 uddg 时跳过，协议相对补 https', () => {
  assert.equal(decodeDdgUrl('//example.com/x'), 'https://example.com/x')
  assert.equal(decodeDdgUrl('https://example.com/x'), 'https://example.com/x')
})

test('decodeBingUrl: 解出 base64url 真实地址', () => {
  const target = 'https://example.com/x?y=1'
  const href = `https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString('base64url')}&ntb=1`
  assert.equal(decodeBingUrl(href), target)
})

test('decodeBingUrl: 退化路径——非 /ck/a 直接透传', () => {
  assert.equal(decodeBingUrl('https://example.com/x'), 'https://example.com/x')
  assert.equal(decodeBingUrl(''), '')
})

test('decodeBingUrl: 失败路径——/ck/a 但无 u 参数 / 非法 URL 均回退原串', () => {
  assert.equal(decodeBingUrl('https://www.bing.com/ck/a?ntb=1'), 'https://www.bing.com/ck/a?ntb=1')
  assert.equal(decodeBingUrl('/ck/a?u=a1zz'), '/ck/a?u=a1zz')
})

test('normalizeUrl: 去 hash 与 tracking 参数', () => {
  const out = normalizeUrl('https://example.com/p?utm_source=x&id=2&fbclid=y#frag')
  assert.equal(out, 'https://example.com/p?id=2')
})

test('normalizeUrl: 失败路径——非法 URL 原样返回（不抛）', () => {
  assert.equal(normalizeUrl('not a url'), 'not a url')
  assert.equal(normalizeUrl(''), '')
})

test('dedupe: 保留首现顺序', () => {
  const out = dedupe([{ k: 'a' }, { k: 'b' }, { k: 'a' }], (t) => t.k)
  assert.deepEqual(out, [{ k: 'a' }, { k: 'b' }])
})

test('dedupe: 退化输入——空数组', () => {
  assert.deepEqual(dedupe([], (t) => String(t)), [])
})

test('str/num: 类型守卫与默认值（退化输入一律回落默认）', () => {
  assert.equal(str('x'), 'x')
  assert.equal(str(undefined, 'd'), 'd')
  assert.equal(str(1), '')
  assert.equal(num(3), 3)
  assert.equal(num(undefined, 7), 7)
  assert.equal(num('3'), 0)
})
