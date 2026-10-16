/**
 * 附件抽取层：URL 或本地文件 → 统一文档模型。
 *
 * 载体选择（2026-10-16）：解析交给 WSL Python —— lxml / beautifulsoup4 /
 * python-docx / openpyxl / pypdf / xlrd 本机已装，零安装成本。
 * TS 侧只做「取字节 + 调用 + 解析 JSON」。
 *
 * 好处：加一种格式 = 改一个 Python 分支，不动 TS（§5.34 可重构性）。
 * 坏处：WSL 不可用时该工具失效 ⇒ **失败必须响亮**，绝不静默回退成「读不了」。
 *
 * 边界（如实声明）：
 *   · 扫描件 PDF 无文本层 ⇒ 只报 warnings，不做 OCR（未验证）
 *   · 老式 OLE .doc/.xls/.ppt ⇒ .xls 已支持（xlrd）；.doc 依赖 antiword（本机 apt 依赖冲突未装上）
 *   · 大表有行数上界（防一次吐爆上下文）
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UA } from './util.js'

const execFileAsync = promisify(execFile)

export interface DocExtract {
  kind: string
  bytes: number
  text: string
  tables: unknown[]
  meta?: Record<string, unknown>
  warnings: string[]
  /** 内容来源（原 URL 或本地路径） */
  source: string
  /** 抽取耗时（含下载） */
  elapsedMs: number
  /** 命中通道：download（下载后抽取）/ local（本地文件） */
  via: 'download' | 'local'
}

/** Windows 路径 → WSL 路径（抽取脚本在 WSL 里跑） */
export function toWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (!m) return p
  return `/mnt/${(m[1] ?? 'e').toLowerCase()}/${(m[2] ?? '').replace(/\\/g, '/')}`
}

/** 本插件 scripts/ 下的抽取脚本（从 lib/ 往上一级） */
export function extractScriptPath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return join(here, '..', 'scripts', 'extract_document.py')
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

/** 下载到文件（二进制安全：用 arrayBuffer，不用 text()） */
async function downloadToFile(url: string, dest: string, timeoutMs: number): Promise<number> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(dest, buf)
    return buf.length
  } finally {
    clearTimeout(timer)
  }
}

export interface DocOpts {
  /** 下载超时（缺省 90s；4.5MB 的 PDF 实测需数十秒） */
  timeoutMs?: number
  /** 表格行数上界（缺省 2000） */
  maxRows?: number
}

/**
 * 抽取一个文档。input 可以是 http(s) URL 或本地绝对路径。
 * 失败一律抛错并带原因（不返回空文本冒充成功）。
 */
export async function fetchDocument(input: string, opts: DocOpts = {}): Promise<DocExtract> {
  const t0 = Date.now()
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-doc-'))
  const maxRows = opts.maxRows ?? 2000
  try {
    let localPath = input
    let via: 'download' | 'local' = 'local'
    if (isHttpUrl(input)) {
      // 用 URL 末段做扩展名线索（sniff 仍以魔数为准）
      const tail = (input.split('?')[0] ?? '').split('/').pop() ?? 'file.bin'
      localPath = join(tmp, tail.replace(/[^\w.\-]/g, '_') || 'file.bin')
      await downloadToFile(input, localPath, opts.timeoutMs ?? 90000)
      via = 'download'
    } else {
      // 本地路径：先确认存在（否则 python 会报「文件不存在」，但那是我该先说清的）
      try {
        const st = statSync(localPath)
        if (!st.isFile()) throw new Error('不是文件')
      } catch (e) {
        throw new Error(`本地文件不可读: ${localPath}（${e instanceof Error ? e.message : e}）`)
      }
    }

    const script = extractScriptPath()
    const args = [toWslPath(script), toWslPath(localPath), '--max-rows', String(maxRows)]
    let stdout = ''
    try {
      const r = await execFileAsync('wsl.exe', ['-d', 'Ubuntu', '--', 'python3', ...args], {
        maxBuffer: 128 * 1024 * 1024,
        timeout: (opts.timeoutMs ?? 90000) + 60000,
      })
      stdout = r.stdout
    } catch (e: any) {
      const msg = e?.stderr ? String(e.stderr).slice(0, 400) : e instanceof Error ? e.message : String(e)
      throw new Error(`WSL 抽取脚本执行失败（WSL 不可用或脚本缺失）: ${msg}`)
    }
    if (!stdout.trim()) throw new Error('抽取脚本无输出（脚本崩了或 python 环境缺包）')

    let parsed: any
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error(`抽取脚本输出不是 JSON: ${stdout.slice(0, 200)}`)
    }
    if (parsed.ok === false) throw new Error(`抽取失败: ${parsed.error ?? '未知原因'}`)

    return {
      kind: String(parsed.kind ?? 'unknown'),
      bytes: Number(parsed.bytes ?? 0),
      text: String(parsed.text ?? ''),
      tables: Array.isArray(parsed.tables) ? parsed.tables : [],
      meta: parsed.meta,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      source: input,
      elapsedMs: Date.now() - t0,
      via,
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
