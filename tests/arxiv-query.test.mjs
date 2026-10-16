/**
 * arxiv 查询表达式与编码测试（纯函数层，零网络）。
 *
 * 存在理由（2026-10-17 线上实测驱动，**三个极端都撞过**）：
 * · 情报目标 `arxiv-deepweb` 的 query `deep web crawling hidden web` 被 arxiv 当 **OR** 解析
 *   ⇒ 20 条结果里强相关仅 2 条（10%），无关 15 条（75%）：`Semantic Web` / `SPARQL` /
 *   `Web 3.0` / `City-on-Web` —— 全都只是含 "web"。
 * · 随后把整串加引号，**过度修正**：五词锁成一个精确短语 ⇒ 从全污染跳到全空。
 * · 改成逐词 `all:` + `AND` 后**仍返回无关论文**（`Manifold DivideMix` / `Backdoor Defenses`）
 *   ⇒ 真因是**编码**：`encodeURIComponent` 把 `all:deep` 编成 `all%3Adeep`，arxiv 不认前缀、
 *   回退成全文检索。官方手册 §5.1 证实冒号是语法成分、空格用 `+`。
 *
 * 判据形态：意图由调用者用语法表达，代码不猜；语法字符（`:`）绝不编码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { arxivQuery, encodeArxivQuery } from '../lib/deep.js'

test('★ 尸体样本：多词必须显式收窄成 AND——裸空格 OR 是线上 75% 噪音的来源', () => {
  // 若 arxivQuery 退化成恒等函数（原样返回），这条立刻挂——这就是它的区分力
  assert.equal(arxivQuery('deep web crawling'), 'all:deep AND all:web AND all:crawling')
  assert.equal(arxivQuery('self-improving agent'), 'all:self-improving AND all:agent')
})

test('★ 重复词去重（`deep web crawling hidden web` 里 web 出现两次）', () => {
  assert.equal(arxivQuery('deep web crawling hidden web'), 'all:deep AND all:web AND all:crawling AND all:hidden')
})

test('单词与空串原样（不加多余语法）', () => {
  assert.equal(arxivQuery('crawler'), 'crawler')
  assert.equal(arxivQuery('  '), '')
  assert.equal(arxivQuery(''), '')
})

test('★ 已含 arxiv 语法的表达式原样透传（代码不替调用者改写意图）', () => {
  // 字段前缀
  assert.equal(arxivQuery('ti:crawler'), 'ti:crawler')
  assert.equal(arxivQuery('abs:"deep web"'), 'abs:"deep web"')
  // 布尔
  assert.equal(arxivQuery('abs:"deep web" AND abs:crawling'), 'abs:"deep web" AND abs:crawling')
  assert.equal(arxivQuery('crawler OR spider'), 'crawler OR spider')
  assert.equal(arxivQuery('web ANDNOT social'), 'web ANDNOT social')
  // 括号
  assert.equal(arxivQuery('(ti:web OR ti:crawl) AND abs:discovery'), '(ti:web OR ti:crawl) AND abs:discovery')
})

test('透传判据不得过宽：小写 or 是普通词，不触发透传', () => {
  // `\b(?:AND|OR|ANDNOT)\b` 大小写敏感——`or` 不该被当操作符
  assert.equal(arxivQuery('web or crawl'), 'all:web AND all:or AND all:crawl')
})

test('★★ 尸体样本：字段前缀的冒号必须原样——编成 %3A 则 arxiv 不认前缀、回退全文检索', () => {
  // 线上实测：encodeURIComponent 版把 `all:deep` 变 `all%3Adeep` ⇒ 3/3 返回无关论文。
  // 若 encodeArxivQuery 退化成 encodeURIComponent，这两条立刻挂。
  assert.equal(encodeArxivQuery('all:deep AND all:web'), 'all:deep+AND+all:web')
  assert.equal(encodeArxivQuery('abs:"deep web"'), 'abs:%22deep+web%22')
  assert.ok(!encodeArxivQuery('all:deep').includes('%3A'), '冒号绝不能被编码')
})

test('encodeArxivQuery：破坏 URL 的字符仍须编码（防注入）', () => {
  assert.equal(encodeArxivQuery('a&b'), 'a%26b')
  assert.equal(encodeArxivQuery('a#b'), 'a%23b')
  // ⚠ 顺序判据：字面加号**先**编码，空格**后**转加号（反了两次都错）
  assert.equal(encodeArxivQuery('a+b c'), 'a%2Bb+c')
})
