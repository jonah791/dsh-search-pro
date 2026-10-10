/**
 * ESM 契约守卫（回归测试 · 尸体测试）。
 *
 * 已证实的缺陷（2026-09-14）：本包 package.json `type=module` + tsconfig `module:NodeNext`
 * ⇒ 产物是纯 ESM；但 `src/robust.ts` 的临时 profile 清理写了 `require('node:fs')`，
 * ESM 下 require 未定义 → 抛错被 `catch {}` 吞掉 → **每次 headless 调用泄漏一个
 * %TEMP%\dsh-robust-<ts> 目录**（实测 15 个 / ~12MB each ≈ 180MB），而日志一片干净。
 *
 * 本测试让这个缺陷不可能复发：产物里一旦出现裸 require( 调用即失败。
 * 前提守卫：若包改成 CJS（type 非 module / module 非 NodeNext），本测试失去意义 → 一并断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function walkJs(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkJs(p))
    else if (ent.name.endsWith('.js')) out.push(p)
  }
  return out
}

test('前提：本包确为 ESM（否则裸 require 是合法写法，本守卫不适用）', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.type, 'module', 'package.json type 必须是 module')
  const ts = readFileSync(join(root, 'tsconfig.json'), 'utf8')
  assert.match(ts, /"module"\s*:\s*"NodeNext"/)
})

test('产物不得出现裸 require( 调用（ESM 下必抛错并被 catch 吞掉）', () => {
  const libDir = join(root, 'lib')
  assert.ok(existsSync(libDir), 'lib/ 不存在——请先构建')
  const offenders = []
  for (const file of walkJs(libDir)) {
    const src = readFileSync(file, 'utf8')
    src.split('\n').forEach((line, i) => {
      // 排除注释行；只抓真正的 require( 调用
      if (/^\s*(\/\/|\*)/.test(line)) return
      if (/\brequire\s*\(/.test(line)) offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], `产物含裸 require（ESM 下未定义）：\n${offenders.join('\n')}`)
})

test('临时 profile 清理必须走清扫器（防修复被无意回退）', () => {
  const src = readFileSync(join(root, 'src', 'robust.ts'), 'utf8')
  // ① 静态导入仍必须在 —— 当年 `require()` 在 ESM 下未定义、被 catch 吞掉、每次调用泄漏一个目录
  assert.match(src, /import\s*\{\s*rmSync\s*\}\s*from\s*'node:fs'/, '必须静态导入 rmSync')
  // ② 清理必须经清扫器 —— 只 kill 直接子进程会漏掉 Chrome 的多进程子树。
  //    2026-10-10 实测：一个 renderer 孤儿满核烧了 46,108 CPU 秒 / 13.4 小时，
  //    而原实现「只 rmSync + try 吞掉」在孤儿占着文件时**静默失败**，目录与进程一起留下。
  assert.match(
    src,
    /cleanupProfileDir\(userData,\s*\(dir\)\s*=>\s*rmSync\(dir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)\)/,
    '必须经 cleanupProfileDir 清理 userData（含删不掉时的按 profile 目录认亲清扫）',
  )
  // ③ 反向断言：不得回退成裸 rmSync(userData) —— 那正是静默失败的老形状
  assert.doesNotMatch(src, /^\s*rmSync\(userData,/m, '不得绕过清扫器直接 rmSync(userData)')
})

/**
 * Bing 端点必须停在 cn 域（回归测试 · 尸体测试）。
 *
 * 已证实的缺陷（2026-10-02）：`https://www.bing.com/search` 对本机出口返回**日文语境**的
 * 结果——中英文共 5 个查询 × 各 2 轮实测（同 httpGet / 同 header / 串行）：
 *   假名标题 5–8/10；中文查询里中文源 0/10；英文查询 #1 也落在日文站（Qiita 等）。
 * 改用 `https://cn.bing.com/search` 后：假名 0，五个查询的 #1 恒为最权威源
 * （python.org / kubernetes.io / 百度百科 / gov.cn），且两轮逐字稳定。
 * 已证伪的替代修法：在 www 上加 `mkt=zh-CN&setlang=zh-Hans` 既不改变语言，
 * 三轮还返回**与查询无关**的页面（百度知道 / 微软蓝牙 / 知乎年金）。
 */
test('bing 端点必须是 cn.bing.com（防止日文语境回退）', () => {
  const src = readFileSync(join(root, 'src', 'engines.ts'), 'utf8')
  const m = src.match(/export async function searchBing[\s\S]*?\n\}/)
  assert.ok(m, '未找到 searchBing 函数体——端点守卫失效，请核对函数名')
  const body = m[0]
  assert.match(body, /https:\/\/cn\.bing\.com\/search/, 'searchBing 必须请求 cn.bing.com')
  assert.doesNotMatch(body, /www\.bing\.com\/search/, 'searchBing 不得回退到 www.bing.com')
  assert.doesNotMatch(body, /mkt=|setlang=/, 'mkt/setlang 实测无效且污染结果，不得重新引入')
})

/**
 * 默认通道组的成员资格（回归测试 · 尸体测试）。
 *
 * 2026-10-02 同批实测驱动的两个调整：
 *   brave 移出：8/8 次 HTTP 429（370–428ms 快速拒绝）。换 4 个差异极大的查询（含单字符 "a"）
 *     全 429 ⇒ **与查询无关**（出口/IP 级），无 key 下在本机出口 100% 不可用。
 *   bing 补入：端点改 cn 域后 11/11 次请求成功（5 查询 × 2 轮 + 线上 1 次），
 *     #1 恒为最权威源。填补 brave 移出后的通道缺口。
 */
test('默认引擎组含 bing、不含 brave（2026-10-02 实测驱动的通道调整）', () => {
  const src = readFileSync(join(root, 'src', 'engines.ts'), 'utf8')
  const m = src.match(/const engines = args\.engines\?\.length \? args\.engines : \[([^\]]+)\]/)
  assert.ok(m, '未找到默认引擎组声明——守卫失效，请核对声明写法')
  const list = m[1]
  assert.match(list, /'bing'/, '实测可用的 bing 必须在默认组')
  assert.doesNotMatch(list, /'brave'/, 'brave 实测 100% 429，不得回到默认组（可显式指定）')
  assert.match(list, /'parallel'/, 'parallel 必须保留')
  assert.match(list, /'duckduckgo'/, 'duckduckgo 必须保留')
})
