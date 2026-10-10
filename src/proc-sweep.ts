/**
 * proc-sweep — 杀掉「持有某个 profile 目录」的全部浏览器进程。
 *
 * 为什么不能用 `child.kill()` 了事（2026-10-10 实测事故，真实工单）：
 * Chrome 是**多进程架构**，主进程退出后 renderer / GPU / utility **不会跟着死**。
 * 一次 headless 抓取的 `--user-data-dir=%TEMP%\dsh-robust-<ts>` 留下的 renderer 孤儿
 * 连续满核烧了 **46,108 CPU 秒（13.4 小时）**，而日志一片干净——主人是被风扇吵醒才发现的。
 * 也不能按 PID 树杀：主进程先死时子树就断了，`taskkill /T` 找不到它。
 * **唯一可靠的认亲凭据是命令行里的 `--user-data-dir`。**
 *
 * 边界（诚实声明）：本实现只在 **Windows** 实测过。POSIX 上子进程随进程组回收，
 * 且本仓未在该平台验证过这条路径 ⇒ 非 Windows 直接返回 0，不做扫进程。
 *
 * 注入安全：搜索凭据经**环境变量**传给 PowerShell，不拼进命令行。
 */
import { execFileSync } from 'node:child_process'

/** 扫进程并杀掉命令行里含 `profileDir` 的进程。返回杀掉的个数；失败返回 0（吞错，观测不反噬主流程）。 */
export function killByProfileDir(profileDir: string): number {
  if (process.platform !== 'win32' || !profileDir) return 0
  const script = [
    '$n = $env:DSH_PROFILE_NEEDLE',
    'if (-not $n) { Write-Output 0; exit 0 }',
    '$hit = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {',
    '  $c = $_.CommandLine',
    '  if (-not $c) { return $false }',
    '  $i = $c.IndexOf($n)',
    '  if ($i -lt 0) { return $false }',
    // 边界感知匹配：needle 之后必须是参数分隔（空格/引号）或字符串结尾。
    // 为什么不能只用 Contains（2026-10-10 阴性对照抓出）：`<dir>-NOT-THIS-ONE` 这类
    // **以它开头但并不是它**的命令行会被 Contains 判成同一族。真实 needle 是 13 位时间戳
    // 路径，实际上不会互为前缀——但「靠数字位数侥幸」不是判据，边界判断才是。
    '  $j = $i + $n.Length',
    '  if ($j -ge $c.Length) { return $true }',
    '  $a = [string]$c[$j]',
    // 接受的边界：参数分隔（空格）· 引号（Chrome 有时给 --user-data-dir="..."）·
    // 路径分隔符（值形如 <dir>\ 或 <dir>/）· 字符串结尾（上面已处理）。
    // 不含字母数字与 `-`：`<dir>4` / `<dir>-suffix` 都不是同一个 profile。
    "  return ($a -eq ' ' -or $a -eq '\"' -or $a -eq '\\' -or $a -eq '/')",
    '})',
    'foreach ($p in $hit) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
    'Write-Output $hit.Count',
  ].join('\n')
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: { ...process.env, DSH_PROFILE_NEEDLE: profileDir },
        windowsHide: true,
        timeout: 15000,
        encoding: 'utf8',
      },
    )
    return Number.parseInt(String(out).trim(), 10) || 0
  } catch {
    return 0
  }
}

/**
 * 删 profile 目录；**删不掉时**才扫进程杀整族再删一次。
 *
 * 为什么要「先删、失败才扫」：扫进程要起一次 PowerShell（约 0.3–1 CPU 秒），
 * 而绝大多数调用都能直接删成功。**目录删不掉本身就是「还有进程活着」的判据**——
 * 用它当触发器，常见路径零成本，异常路径才付代价。
 *
 * 返回 { swept, removed }：swept = 杀掉几个（0 表示本来就没进程占着）；removed = 最终删掉没有。
 */
export function cleanupProfileDir(profileDir: string, rm: (dir: string) => void): { swept: number; removed: boolean } {
  try {
    rm(profileDir)
    return { swept: 0, removed: true }
  } catch { /* 目录被占（Windows 上文件被打开即删不掉）⇒ 走扫进程 */ }
  const swept = killByProfileDir(profileDir)
  try {
    rm(profileDir)
    return { swept, removed: true }
  } catch {
    return { swept, removed: false }
  }
}
