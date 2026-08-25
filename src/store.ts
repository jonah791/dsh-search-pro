/** F 组 · 系统管理：结果缓存 + 通道配额统计 */

export interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class SearchStore {
  private cache = new Map<string, CacheEntry<unknown>>()
  private counts = new Map<string, number>()
  private ttlMs: number

  constructor(ttlMs = 3600_000) {
    this.ttlMs = ttlMs
  }

  /** 记录一次通道调用 */
  bump(channel: string): void {
    this.counts.set(channel, (this.counts.get(channel) ?? 0) + 1)
  }

  get<T>(key: string): T | undefined {
    const e = this.cache.get(key)
    if (!e) return undefined
    if (Date.now() > e.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    return e.value as T
  }

  set(key: string, value: unknown): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    // 防无限膨胀
    if (this.cache.size > 500) {
      const now = Date.now()
      for (const [k, v] of this.cache) {
        if (now > v.expiresAt) this.cache.delete(k)
      }
    }
  }

  clear(query?: string): number {
    if (!query) {
      const n = this.cache.size
      this.cache.clear()
      return n
    }
    let n = 0
    for (const k of [...this.cache.keys()]) {
      if (k.includes(query)) {
        this.cache.delete(k)
        n++
      }
    }
    return n
  }

  list(): { key: string; size: number; ttlSec: number }[] {
    const now = Date.now()
    return [...this.cache.entries()].map(([k, v]) => ({
      key: k,
      size: JSON.stringify(v.value).length,
      ttlSec: Math.max(0, Math.round((v.expiresAt - now) / 1000)),
    }))
  }

  countsSnapshot(): Record<string, number> {
    return Object.fromEntries(this.counts)
  }
}
