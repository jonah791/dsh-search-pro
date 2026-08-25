/** 深度测试：真实 defineTool 注册 + 实际 execute 执行 */
import { apply } from '../lib/index.js'
import { defineTool } from '@deepseek-ai/dsh-tools'

const tools = []
const ctx = {
  tools: { register: (t) => tools.push(t) },
  logger: () => ({ info: () => {} }),
}
apply(ctx, {
  enabled: true, tavilyKey: '', serperKey: '', shodanKey: '', securityTrailsKey: '',
  githubToken: '', jinaKey: '', defaultLang: 'zh', cacheTtlMinutes: 60,
})

console.log('registered:', tools.length)

const run = async (name, args) => {
  const t = tools.find((x) => x?.name === name)
  if (!t) return console.log(`[${name}] NOT FOUND`)
  try {
    const r = await t.execute(args, {})
    const s = JSON.stringify(r)?.slice(0, 250)
    console.log(`[${name}] OK -> ${s}`)
  } catch (e) {
    console.log(`[${name}] EXEC ERROR -> ${e?.stack ?? e}`)
  }
}

await run('search_web', { query: 'deepseek v3' })
await run('search_quota', {})
await run('search_academic', { query: 'rag survey', limit: 3 })
await run('archive_search', { url: 'example.com', limit: 3 })
