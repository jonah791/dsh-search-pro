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

test('临时 profile 清理路径必须存在（防止修复被无意回退）', () => {
  const src = readFileSync(join(root, 'src', 'robust.ts'), 'utf8')
  assert.match(src, /import\s*\{\s*rmSync\s*\}\s*from\s*'node:fs'/, '必须静态导入 rmSync')
  assert.match(src, /rmSync\(userData,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/, '必须清理 userData')
})
