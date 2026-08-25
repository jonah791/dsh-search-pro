/** 用 fake ctx 验证 apply 是否抛错 + 工具注册数 */
import { apply, Config } from '../lib/index.js'

const tools = []
const ctx = {
  tools: { register: (t) => { tools.push(t?.name ?? '?') } },
  logger: () => ({ info: (...a) => console.log('INFO:', ...a) }),
}

const cfg = {
  enabled: true, tavilyKey: '', serperKey: '', shodanKey: '', securityTrailsKey: '',
  githubToken: '', jinaKey: '', defaultLang: 'zh', cacheTtlMinutes: 60,
}

try {
  apply(ctx, cfg)
  console.log('REGISTERED:', tools.length)
  console.log(tools.join(', '))
} catch (e) {
  console.error('APPLY ERROR:', e?.stack ?? e)
}
