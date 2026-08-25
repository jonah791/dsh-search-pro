/** 验证：真实 defineTool 后，用 validateJsonSchemaValue 校验 execute 返回值 */
import { apply } from '../lib/index.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '../node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'

const tools = []
const ctx = {
  tools: { register: (t) => tools.push(t) },
  logger: () => ({ info: () => {} }),
}
apply(ctx, {
  enabled: true, tavilyKey: '', serperKey: '', shodanKey: '', securityTrailsKey: '',
  githubToken: '', jinaKey: '', defaultLang: 'zh', cacheTtlMinutes: 60,
})

const run = async (name, args) => {
  const t = tools.find((x) => x?.name === name)
  const r = await t.execute(args, {})
  const v = validateJsonSchemaValue(t.output.schema, r, `value`)
  console.log(`[${name}] validate violations:`, v.length ? v : 'NONE')
  if (v.length) console.log('  value:', JSON.stringify(r)?.slice(0, 200))
}

await run('search_web', { query: 'deepseek v3' })
await run('search_quota', {})
await run('search_academic', { query: 'rag', limit: 3 })
await run('fetch_page', { url: 'https://example.com' })
await run('lookup_whois', { domain: 'example.com' })
