/* 用 JavDB 网页版演员页的 section-meta 判定性别（权威判据）。
 * 规则：页面 section-meta 里有「男優」= 男优；没有 = 女优
 * （女优页面的 section-meta 只有「NN 部影片」，不带性别字样）。
 * 修正 actors_full.json 里被名册反查误判成男优的女优。 */
const fs = require('fs')
const { execSync } = require('child_process')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const CLEAN = { ...process.env }
;['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'PROXY', 'ALL_PROXY', 'all_proxy'].forEach(k => delete CLEAN[k])
const PROXY = process.env.GENDER_PROXY || 'http://127.0.0.1:1082'   // 网页版要出海才拿得到

function fetchHtml(id) {
  try {
    return execSync(`curl -s --max-time 25 -x ${PROXY} -A "${UA}" "https://javdb.com/actors/${id}"`,
      { encoding: 'utf8', timeout: 30000, env: CLEAN })
  } catch (e) { return '' }
}

;(async () => {
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const suspects = d.list.filter(a => a.gender === 'm')
console.log('待判定（原标男优）:', suspects.length)

// 并发 8 路（串行 256 次要 10+ 分钟）
const realMale = [], realFemale = [], fail = []
const slots = new Array(suspects.length).fill(null)
let done = 0
await Promise.all(Array.from({ length: 8 }, async () => {
  while (true) {
    const i = done++
    if (i >= suspects.length) break
    const a = suspects[i]
    const h = fetchHtml(a.id)
    if (!h) { slots[i] = { a, bad: true }; continue }
    // ⚠️ 必须 matchAll：section-meta 有多个（别名标签 + 「男優, N 部影片」），
    // 只取第一个会拿到别名（不含「男優」）→ 把鮫島/黒田悠斗这类真男优误判成女优。
    const metas = [...h.matchAll(/section-meta">([^<]+)</g)].map(x => x[1])
    slots[i] = { a, male: metas.some(t => /男優/.test(t)) }
    if (i % 40 === 0) console.log('  ' + i + '/' + suspects.length)
  }
}))
for (const s of slots) {
  if (!s) continue
  if (s.bad) fail.push(s.a.name)
  else if (s.male) realMale.push(s.a)
  else realFemale.push(s.a)
}
console.log('  → 男优 ' + realMale.length + ' · 女优 ' + realFemale.length + ' · 失败 ' + fail.length)
console.log('\n真男优样例:', realMale.slice(0, 10).map(a => a.name).join('、'))
console.log('被纠正的女优:', realFemale.slice(0, 16).map(a => a.name).join('、'))

// 写回：纠正 gender
const byId = new Map(realFemale.map(a => [a.id, 'f']))
let changed = 0
for (const a of d.list) {
  if (a.gender === 'm' && byId.get(a.id) === 'f') { a.gender = 'f'; changed++ }
}
d.female = d.list.filter(a => a.gender === 'f').length
d.male = d.list.filter(a => a.gender === 'm').length
d.genderSource = 'javdb-web-section-meta'
fs.writeFileSync(process.argv[3], JSON.stringify(d))
console.log('\n已纠正 ' + changed + ' 位 → 女优 ' + d.female + ' · 男优 ' + d.male)
if (fail.length) console.log('失败名单（保留原判）:', fail.slice(0, 10).join('、'))
})()
