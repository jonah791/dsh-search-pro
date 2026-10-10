/**
 * proc-sweep 的标定 —— 两半，各证一件事：
 *
 *   ① **真尸体**（真 IO）：命令行里带某 profile 目录的进程，真的会被 `killByProfileDir` 杀掉，
 *      而不带该目录的进程**不受影响**（阴性对照 —— 少这一条，一个「见谁都杀」的实现在测试里也全绿）。
 *   ② **触发条件**（纯逻辑，注入 rm）：`cleanupProfileDir` 只在**删失败之后**才付出扫进程的代价，
 *      且失败后必重试一次。这条用注入的 rm 造失败，因此与平台无关。
 *
 * 为什么值得单独标定：2026-10-10 一个 renderer 孤儿满核烧了 46,108 CPU 秒 / 13.4 小时，
 * 而整套清理逻辑在 try/catch 里**静默成功**。判据不自证，这类回归就没人拦得住。
 *
 * Run: node --test tests/proc-sweep.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killByProfileDir, cleanupProfileDir } from '../lib/proc-sweep.js'

const WIN = process.platform === 'win32'
const SKIP = WIN ? false : '扫进程路径仅在 Windows 实测过（见 proc-sweep.ts 头部边界声明）'

/**
 * 尸体夹具：一个「睡眠 60 秒」的普通 node 进程。
 *
 * ⚠ **必须落成脚本文件，不能用 `node -e "<code>" --user-data-dir=X`**：实测那种写法下
 * node 把 `--user-data-dir=...` 当成**自己的**未知选项并以**退出码 9** 立刻退出 ——
 * 于是「尸体」压根没起来，而断言失败看起来像被测对象的缺陷。
 * （夹具问题 vs 缺陷真实，是测试红的第一道分诊。）指定脚本文件后，`--` 开头的参数
 * 才会真正落进 `process.argv`，命令行里也就真的带上了那个 profile 目录。
 */
const SLEEPER = join(tmpdir(), 'proc-sweep-sleeper.mjs')
writeFileSync(SLEEPER, 'setTimeout(() => {}, 60000)\n')
after(() => { try { rmSync(SLEEPER, { force: true }) } catch { /* 忽略 */ } })

/** 造一具「命令行里含 $needle」的长命进程并等它真的起来。 */
async function spawnCorpse(needle) {
  const child = spawn(process.execPath, [SLEEPER, '--user-data-dir=' + needle], {
    windowsHide: true,
    stdio: 'ignore',
  })
  await new Promise((r) => setTimeout(r, 900))
  return child
}

/** 等进程退出（最多 4 秒）。外部杀掉时 Node 不一定填 exitCode，所以看 exit 事件。 */
function waitExit(child, ms = 4000) {
  return Promise.race([
    new Promise((r) => child.on('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ])
}

test('尸体样本：命令行带该 profile 目录的进程会被杀', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proc-sweep-corpse-'))
  const corpse = await spawnCorpse(dir)
  try {
    assert.equal(corpse.exitCode, null, '前置：尸体应当还活着')
    const killed = killByProfileDir(dir)
    assert.ok(killed >= 1, `应至少杀掉 1 个，实际 ${killed}`)
    assert.equal(await waitExit(corpse), true, '尸体应当已被终止')
  } finally {
    try { corpse.kill() } catch { /* 已经死了 */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('阴性对照：命令行不含该目录的进程不受影响', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proc-sweep-bystander-'))
  const bystander = await spawnCorpse(dir + '-NOT-THIS-ONE')
  try {
    killByProfileDir(dir)
    await new Promise((r) => setTimeout(r, 700))
    assert.equal(bystander.exitCode, null, '旁证进程不该被杀（判据必须只认自己的目录）')
  } finally {
    try { bystander.kill() } catch { /* 忽略 */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanupProfileDir：删得掉时**不**付扫进程的代价', () => {
  let calls = 0
  const r = cleanupProfileDir('X:\\nope', () => { calls += 1 })
  assert.equal(calls, 1, '只该删一次')
  assert.deepEqual(r, { swept: 0, removed: true })
})

test('cleanupProfileDir：删失败 ⇒ 清扫一次并重删', () => {
  let calls = 0
  const r = cleanupProfileDir('X:\\nope', () => {
    calls += 1
    if (calls === 1) throw new Error('EBUSY: 目录被占用')
  })
  assert.equal(calls, 2, '失败后必须重删一次（证明清扫之后确实重试了）')
  assert.equal(r.removed, true)
})

test('cleanupProfileDir：重删仍失败 ⇒ 如实报 removed:false（不谎报成功）', () => {
  const r = cleanupProfileDir('X:\\nope', () => { throw new Error('EBUSY') })
  assert.equal(r.removed, false, '删不掉必须如实返回 false —— 谎报成功正是本次事故的形状')
})
