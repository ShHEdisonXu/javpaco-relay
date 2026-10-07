/* 生成 relay/female_names.json：女优名字集合（归一化前的原始名）。
 * 用途：GitHub Actions 里没有 16MB 的 actresses.json（名册），名册反查那一级会整个失效，
 *       导致新抓的演员全被判成男优。这份精简名单（只要名字）让 Actions 也能做名册反查。
 * 来源：① minnano 名册 actresses.json  ② actors_full.json 里已判定为女优的（含 JavDB 独有欧美/无码演员）
 *       ③ uncensored_actresses.json 里 gender==='f' 的 */
const fs = require('fs'), path = require('path')
const RELAY = path.join(__dirname, 'relay')
const set = new Set()
const add = n => { if (n && String(n).length < 60) set.add(String(n).trim()) }
let roster = []
try { roster = JSON.parse(fs.readFileSync(path.join(__dirname, 'actresses.json'), 'utf8')) || [] } catch (_) {}
for (const a of roster) {
  if (!a) continue
  add(a.name); [a.name_ja, a.name_zh, a.name_en].forEach(add)
  if (Array.isArray(a.alias)) a.alias.forEach(add)
}
const addFromFile = (f) => {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(RELAY, f), 'utf8')) || {}
    for (const a of (d.list || [])) {
      if (!a || a.gender !== 'f') continue
      add(a.name); add(a.name_zht); add(a.other_name)
      String(a.other_name || '').split(/[,，、]/).forEach(add)
    }
  } catch (_) {}
}
addFromFile('actors_full.json'); addFromFile('uncensored_actresses.json')
const names = [...set].filter(Boolean)
fs.writeFileSync(path.join(RELAY, 'female_names.json'), JSON.stringify({ fetchedAt: Date.now(), source: 'minnano-roster+javdb-verified', count: names.length, names }))
console.log('relay/female_names.json：' + names.length + ' 个女优名字，' + (fs.statSync(path.join(RELAY, 'female_names.json')).size / 1048576).toFixed(2) + ' MB')
