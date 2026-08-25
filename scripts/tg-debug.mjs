const { httpGet, stripTags } = await import('../lib/util.js')
const html = await httpGet('https://t.me/s/durov', { timeoutMs: 20000 })
const re = /data-post="([^"]+)"/g
let m
while ((m = re.exec(html))) {
  if (m[1] === 'durov/523') {
    const start = m.index + m[0].length
    const next = html.indexOf('data-post="', start)
    const raw = html.slice(start, next > 0 ? next : start + 800)
    console.log('RAW head:', JSON.stringify(raw.slice(0, 400)))
    console.log('---')
    console.log('STRIPPED:', JSON.stringify(stripTags(raw).slice(0, 150)))
    break
  }
}
