/**
 * 情报系统 · 持久化层。
 *
 * 布局（<DSH_HOME>/intel/）：
 *   targets.json          监控目标（原子写：temp + rename）
 *   snapshots/<id>.json   每个目标的已知指纹集合（**增量判据的真源**）
 *   items.jsonl           条目事件流（append-only；同 id 后写胜 = 事件溯源）
 *
 * 纪律（§5.10 静默失败）：
 *   · 「空」与「读坏了」是两件事——targets.json 不存在 = 空（首次使用）；
 *     JSON 坏 = 响亮报错，绝不静默当作空（否则情报会凭空消失而无人知道）
 *   · items.jsonl 的坏行计数必须透出（不整库报废，但也不假装没有）
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IntelItem, IntelTarget } from './intel.js'

/** DSH 数据面根（与 trace.ts 同源语义，但各自解析以免耦合） */
export function resolveDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export interface ItemsLoad {
  items: IntelItem[]
  /** 无法解析的行数（0 是常态；>0 说明文件被外力破坏过） */
  badLines: number
}

export class IntelStore {
  readonly dir: string
  private readonly targetsPath: string
  private readonly snapDir: string
  private readonly itemsPath: string

  constructor(dir?: string) {
    this.dir = dir ?? join(resolveDshHome(), 'intel')
    this.targetsPath = join(this.dir, 'targets.json')
    this.snapDir = join(this.dir, 'snapshots')
    this.itemsPath = join(this.dir, 'items.jsonl')
    mkdirSync(this.snapDir, { recursive: true })
  }

  private writeJsonAtomic(path: string, data: unknown): void {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8')
      renameSync(tmp, path)
    } catch (e) {
      // 失败要清理临时文件，且把错误抛出去（不静默）
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* 清理失败不掩盖原错 */
      }
      throw e
    }
  }

  // ── targets ──────────────────────────────────────────────────────────

  listTargets(): IntelTarget[] {
    if (!existsSync(this.targetsPath)) return []
    const raw = readFileSync(this.targetsPath, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`targets.json 损坏（不是合法 JSON）：${this.targetsPath}——拒绝静默当作空`)
    }
    if (!Array.isArray(parsed)) throw new Error(`targets.json 不是数组：${this.targetsPath}`)
    return parsed as IntelTarget[]
  }

  getTarget(id: string): IntelTarget | undefined {
    return this.listTargets().find((t) => t.id === id)
  }

  upsertTarget(t: IntelTarget): void {
    const all = this.listTargets()
    const i = all.findIndex((x) => x.id === t.id)
    if (i >= 0) all[i] = { ...all[i], ...t }
    else all.push(t)
    this.writeJsonAtomic(this.targetsPath, all)
  }

  /** 只更新部分字段（不整体替换，避免调用方漏字段把 lastScanAt 抹掉） */
  patchTarget(id: string, patch: Partial<IntelTarget>): boolean {
    const all = this.listTargets()
    const i = all.findIndex((x) => x.id === id)
    if (i < 0) return false
    all[i] = { ...all[i], ...patch } as IntelTarget
    this.writeJsonAtomic(this.targetsPath, all)
    return true
  }

  removeTarget(id: string): boolean {
    const all = this.listTargets()
    const next = all.filter((t) => t.id !== id)
    if (next.length === all.length) return false
    this.writeJsonAtomic(this.targetsPath, next)
    // 快照一并清掉（否则重加同名目标会「继承」旧快照，增量判据失真）
    const snap = this.snapPath(id)
    try {
      if (existsSync(snap)) unlinkSync(snap)
    } catch {
      /* 快照删不掉不影响主流程，但下次 add 时 loadSnapshot 会读到旧值——由 add 流程负责清理 */
    }
    return true
  }

  // ── snapshots（增量判据的真源）────────────────────────────────────────

  private snapPath(targetId: string): string {
    return join(this.snapDir, `${targetId.replace(/[^\w.\-]/g, '_')}.json`)
  }

  loadSnapshot(targetId: string): Set<string> {
    const p = this.snapPath(targetId)
    if (!existsSync(p)) return new Set()
    const raw = readFileSync(p, 'utf8')
    try {
      const parsed = JSON.parse(raw)
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.urls) ? parsed.urls : null
      if (!arr) throw new Error('shape')
      return new Set(arr.map((x: unknown) => String(x)))
    } catch {
      throw new Error(`快照损坏：${p}——拒绝静默当作空（否则整站会被重新报成新）`)
    }
  }

  saveSnapshot(targetId: string, fingerprints: string[], meta: Record<string, unknown> = {}): void {
    this.writeJsonAtomic(this.snapPath(targetId), {
      targetId,
      savedAt: new Date().toISOString(),
      count: fingerprints.length,
      ...meta,
      urls: [...new Set(fingerprints)],
    })
  }

  /** 丢弃快照（重加目标时用，避免继承旧快照） */
  clearSnapshot(targetId: string): void {
    const p = this.snapPath(targetId)
    if (existsSync(p)) unlinkSync(p)
  }

  // ── items（事件流）───────────────────────────────────────────────────

  loadItems(): ItemsLoad {
    if (!existsSync(this.itemsPath)) return { items: [], badLines: 0 }
    const text = readFileSync(this.itemsPath, 'utf8')
    const byId = new Map<string, IntelItem>()
    let badLines = 0
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const o = JSON.parse(s)
        if (o && typeof o.id === 'string') byId.set(o.id, o as IntelItem)
        else badLines++
      } catch {
        badLines++
      }
    }
    return { items: [...byId.values()], badLines }
  }

  /** 追加条目（返回实际写入行数）；同 id 重复写 = 状态更新（后写胜） */
  appendItems(items: IntelItem[]): number {
    if (items.length === 0) return 0
    mkdirSync(this.dir, { recursive: true })
    const body = items.map((it) => JSON.stringify(it)).join('\n') + '\n'
    appendFileSync(this.itemsPath, body, 'utf8')
    return items.length
  }

  /** 列条目（按发现时间降序；可按目标/状态过滤） */
  listItems(opts: { targetId?: string; status?: string; limit?: number } = {}): ItemsLoad & { filtered: number } {
    const { items, badLines } = this.loadItems()
    let out = items
    if (opts.targetId) out = out.filter((i) => i.targetId === opts.targetId)
    if (opts.status) out = out.filter((i) => i.status === opts.status)
    const filtered = out.length
    out = out.slice().sort((a, b) => String(b.foundAt).localeCompare(String(a.foundAt)))
    if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit)
    return { items: out, badLines, filtered }
  }

  /** 更新条目状态（append 一条同 id 记录 = 后写胜） */
  updateStatus(id: string, status: IntelItem['status']): boolean {
    const { items } = this.loadItems()
    const found = items.find((i) => i.id === id)
    if (!found) return false
    this.appendItems([{ ...found, status }])
    return true
  }

  /** 已知指纹全集（跨目标——用于「这条是不是别处已经报过」的去重） */
  knownFingerprints(): Set<string> {
    return new Set(this.loadItems().items.map((i) => i.id))
  }
}
