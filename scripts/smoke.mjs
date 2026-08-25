/** 快速验证：直调 lib 模块（不经插件挂载） */
import { searchWeb } from '../lib/engines.js'
import { searchAcademic } from '../lib/deep.js'
import { cdxSearch } from '../lib/archive.js'
import { buildQueries } from '../lib/buildQuery.js'
import { htmlToText } from '../lib/util.js'

const run = async (label, fn) => {
  try {
    const r = await fn()
    console.log(`\n=== ${label} === (${r.length ?? 'n/a'} 条)`)
    for (const x of (Array.isArray(r) ? r : [r]).slice(0, 3)) {
      console.log(`• ${x.title?.slice(0, 60)}\n  ${x.url?.slice(0, 90)}\n  ${String(x.snippet ?? '').slice(0, 80)}`)
    }
  } catch (e) {
    console.log(`\n=== ${label} === ERROR: ${e.message}`)
  }
}

// 查询改写
console.log('=== buildQueries ===')
console.log(buildQueries({ intent: '查找冷门技术', keywords: 'stable diffusion webui install', lang: 'zh', grammarBoost: true }))

await run('search_web(duckduckgo)', () => searchWeb({ query: 'deepseek v3 paper', engines: ['duckduckgo'], pages: 1 }))
await run('search_web(bing)', () => searchWeb({ query: 'deepseek v3 paper', engines: ['bing'], pages: 1 }))
await run('search_academic', () => searchAcademic('deepseek', undefined, 5))
await run('archive_search(example.com)', () => cdxSearch('example.com', undefined, undefined, 5))

// htmlToText 简单自测
console.log('\n=== htmlToText ===')
console.log(htmlToText('<html><head><title>t</title></head><body><main><p>hello <b>world</b></p></main></body></html>').slice(0, 80))
