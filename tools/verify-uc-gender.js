/* 复核 uncensored_actresses.json 里被判为男优/未知的条目（只问这些，省请求）。
 * 用法：node verify-uc-gender.js <输入> <输出> [并发] */
const fs = require('fs')
const { execSync } = require('child_process')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const PROXY = process.env.WEB_PROXY || ''
function webGender(id) {
  const cmd = `curl -s --max-time 25 ${PROXY ? '-x ' + PROXY + ' ' : ''}-A "${UA}" "https://javdb.com/actors/${id}"`
  let h = ''
  try {
    const env = { ...process.env }
    ;['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'].forEach(k => delete env[k])
    h = execSync(cmd, { encoding: 'utf8', timeout: 30000, env, stdio: ['ignore','pipe','ignore'] })
  } catch (_) { return null }
  const metas = [...String(h).matchAll(/section-meta">([^<]+)</g)].map(x => x[1])
  if (!metas.length) return null
  return metas.some(t => /男優/.test(t)) ? 'm' : 'f'
}
;(async () => {
  const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const list = d.list || []
  const targets = list.filter(a => a && a.id && a.gender !== 'f')
  const CONC = +(process.argv[4] || 4)
  console.log('待复核（非女优）' + targets.length + ' / 共 ' + list.length + '，并发 ' + CONC)
  const slots = new Array(targets.length).fill(null)
  let done = 0, ok = 0, bad = 0
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (true) {
      const i = done++
      if (i >= targets.length) break
      const g = webGender(targets[i].id)
      slots[i] = g
      if (g) ok++; else bad++
      if (i % 25 === 0) console.log('  ' + i + '/' + targets.length)
    }
  }))
  let changed = 0
  targets.forEach((a, i) => {
    const g = slots[i]
    if (!g) return
    if (g !== a.gender) { console.log('  ' + a.name + '：' + a.gender + ' → ' + g); changed++ }
    a.gender = g
    a.genderSource = 'javdb-web-section-meta'
  })
  const f = list.filter(a => a.gender === 'f').length
  console.log('复核成功 ' + ok + ' · 取不到 ' + bad + ' · 纠正 ' + changed + ' → 女优 ' + f + ' · 男优 ' + list.filter(a=>a.gender==='m').length)
  fs.writeFileSync(process.argv[3], JSON.stringify(d))
})()
