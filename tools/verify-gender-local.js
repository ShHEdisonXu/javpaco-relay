/* 本地复核 actors_full.json 里「性别不可信」的条目（网页版 section-meta，权威判据）。
 * 背景：GitHub Actions 里 javdb.com 被 Cloudflare 拦（403），名册又缺失 → 新增演员全被判男优。
 * 本地（家庭宽带）直连 javdb.com 200，可以逐个问。
 * 用法：node verify-gender-local.js <输入> <输出> */
const fs = require('fs')
const { execSync } = require('child_process')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const PROXY = process.env.WEB_PROXY || ''      // 本地一般直连即可；需要时 WEB_PROXY=http://127.0.0.1:1082
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
  // 只问「还没被网页版判过」的：男优（可能混女优）+ 来源不是 javdb-web-section-meta 的
  const targets = list.filter(a => a && a.id && (a.genderSource !== 'javdb-web-section-meta'))
  console.log('待复核 ' + targets.length + ' / 共 ' + list.length)
  const slots = new Array(targets.length).fill(null)
  let done = 0, ok = 0, bad = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (true) {
      const i = done++
      if (i >= targets.length) break
      const g = webGender(targets[i].id)
      slots[i] = g
      if (g) ok++; else bad++
      if (i % 40 === 0) console.log('  ' + i + '/' + targets.length)
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
  d.female = list.filter(a => a.gender === 'f').length
  d.male = list.filter(a => a.gender === 'm').length
  fs.writeFileSync(process.argv[3], JSON.stringify(d))
  console.log('复核成功 ' + ok + ' · 取不到 ' + bad + ' · 纠正 ' + changed + ' → 女优 ' + d.female + ' · 男优 ' + d.male)
})()
