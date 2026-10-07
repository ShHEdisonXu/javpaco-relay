#!/usr/bin/env node
/* JavDB「无码女优」名单（GitHub Actions 内运行，机房直连国内线路无墙）：
 * 思路：**不逐个查名字，而是翻 JavDB 的无码影片（type=1）反推演员** ——
 * 出现在无码影片里的演员，就是 JavDB 认定的无码演员。比对 2.5 万女优逐个搜名字
 * 便宜几个数量级（12 页 360 部影片 → 203 位女优）。
 * 性别再用「名册反查」判定（照抄 actors-full-crawl.js 的 genderOf）。
 * 产物 relay/uncensored_actresses.json：{ fetchedAt, count, list:[{id,name,videos_count,uc_codes}] }
 *
 * 判据说明：无码只体现在「影片 type=1 + 番号 n 前缀」，JavDB 没有演员维度的无码字段，
 * 所以「出现在无码影片里」就是最贴近 JavDB 口径的判据。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/* ---- JavDB 移动端 API：国内线路 + 应用级签名（照抄 server.js 的 jdbSign） ---- */
const JDB_LINES = ['https://apidd.spthgb.com', 'https://apidd.czssdgz.com', 'https://jdforrepam.com']
const JDB_P1 = '71cf27bb3c0bcdf207b64abecddc970098c7421ee7203b9cdae54478478a199e7d5a6e1a57691123c1a931c057842fb73ba3b3c83bcd69c17ccf174081e3d8aa'
const JDB_P2 = 'lpw6vgqzsp'
function jdbSign() {
  const ts = Math.floor(Date.now() / 1000)
  return ts + '.' + JDB_P2 + '.' + crypto.createHash('md5').update(String(ts) + JDB_P1).digest('hex')
}

const RELAY_DIR = process.env.RELAY_DIR || path.join(__dirname, 'relay')
const OUT_JSON = path.join(RELAY_DIR, 'uncensored_actresses.json')
const TIMEOUT = 20000
const PAGES = +(process.env.UC_PAGES || 120)       // 翻多少页无码影片（每页 30 部）
let LINE_OK = ''

async function jdbGet(rel) {
  const order = LINE_OK && JDB_LINES.includes(LINE_OK) ? [LINE_OK].concat(JDB_LINES.filter(x => x !== LINE_OK)) : JDB_LINES
  let lastErr = null
  for (const base of order) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT)
    try {
      const r = await fetch(base + '/api/' + rel, {
        signal: ac.signal,
        headers: { jdsignature: jdbSign(), 'User-Agent': 'Dart/3.5 (dart:io)', 'Accept-Language': 'zh-TW', Accept: 'application/json' }
      })
      if (!r.ok) throw new Error(base + ' → ' + r.status)
      const j = await r.json()
      if (j && j.success === 0) throw new Error(j.message || 'API 返回失败')
      LINE_OK = base
      return j
    } catch (e) { lastErr = e } finally { clearTimeout(timer) }
  }
  throw lastErr || new Error('JavDB 线路均不可用')
}

const pool = async (items, n, fn) => {
  const out = []; let i = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k) } catch (_) { out[k] = null } }
  }))
  return out
}

/* 名字归一化（含片假名/汉字→平假名，照抄 server.js 的 onKana + onNorm） */
const onKana = s => String(s || '').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
const onNorm = s => onKana(String(s || '')).toLowerCase().replace(/[\s　・·,，、/]+/g, '')

/* 名册（minnano 全量女优）→ 名字集合。命中 = 女优 */
let FEM_NAMES = null
function loadFemaleNames() {
  if (FEM_NAMES) return FEM_NAMES
  FEM_NAMES = new Set()
  const ROSTER = path.join(RELAY_DIR, '..', 'actresses.json')
  let roster = []
  try { roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8')) || [] } catch (_) {}
  const push = n => { const k = onNorm(n); if (k) FEM_NAMES.add(k) }
  for (const a of roster) {
    if (!a || !a.name) continue
    push(a.name)
    ;[a.name_ja, a.name_zh, a.name_en].forEach(n => n && push(n))
    if (Array.isArray(a.alias)) a.alias.forEach(push)
  }
  return FEM_NAMES
}

;(async () => {
  console.log('① 翻 JavDB 无码影片（type=1）反推演员…')
  const found = new Map()      // id → {name, codes:Set(番号样本)}
  let stall = 0
  for (let page = 1; page <= PAGES; page++) {
    let list = []
    try {
      const j = await jdbGet('v1/movies/latest?filter_by=magnets&limit=30&page=' + page + '&sort_by=update&type=1')
      list = ((j || {}).data || {}).movies || []
    } catch (e) { console.log('   第' + page + '页失败：' + e.message); break }
    if (!list.length) break
    const det = await pool(list.map(m => m.id).filter(Boolean), 8, async id => {
      try { const d = await jdbGet('v2/movies/' + id); return ((d || {}).data || {}).movie || {} } catch (_) { return null }
    })
    let added = 0
    for (const mv of det) {
      if (!mv) continue
      const code = String(mv.number || mv.code || '')
      for (const a of (mv.actors) || []) {
        if (!a || !a.id || !a.name) continue
        const cur = found.get(a.id)
        if (!cur) { found.set(a.id, { name: a.name, codes: new Set() }); added++ }
        if (code) found.get(a.id).codes.add(code)
        if (!cur && a.name) { /* 名字已在 cur 里 */ }
      }
    }
    if (page % 20 === 0) console.log('   第' + page + '页 → 演员累计 ' + found.size + '（本页新增 ' + added + '）')
    stall = added === 0 ? stall + 1 : 0
    if (stall >= 3) { console.log('   连续 3 页无新演员，翻完了'); break }
  }
  console.log('   无码影片反推共 ' + found.size + ' 位演员')

  console.log('② 拉详情 + 性别判定（名册反查）…')
  const fem = loadFemaleNames()
  const out = { fetchedAt: Date.now(), source: 'javdb-uncensored', count: 0, list: [] }
  const ids = [...found.keys()]
  let isFem = 0, isMale = 0
  await pool(ids, 4, async id => {
    const base = found.get(id)
    let vc = 0, alias = ''
    try {
      const d = await jdbGet('v1/actors/' + encodeURIComponent(id))
      const ac = (((d || {}).data || {}).actor || {})
      if (!ac.name) return
      base.name = ac.name
      alias = ac.other_name || ''
      if (ac.videos_count != null) vc = Number(ac.videos_count) || 0
      if (ac.avatar_url) base.avatar_url = ac.avatar_url
    } catch (_) {}
    /* 性别判定：**男女都收进名单**，用 gender 字段标出来。
     * 为什么不按名册反查筛女优：名册每天自动同步会漂移（本地 24959 → 线上 25431），
     * 拿旧名册筛会把新名册里的无码演员漏掉；而且男优出现在无码影片里也是常态（混合厂片）。
     * 前端按 gender 取女优即可，也不依赖名册。 */
    const keys = [base.name].concat(String(alias).split(','))
    const isFemale = keys.some(k => k && fem.has(onNorm(k)))
    if (isFemale) isFem++; else isMale++
    out.list.push({
      id,
      name: base.name,
      other_name: alias,
      gender: isFemale ? 'f' : 'm',
      videos_count: vc,
      uc_codes: [...base.codes].slice(0, 5),
      uc_count: base.codes.size,
      avatar_url: base.avatar_url || ''
    })
  })
  out.count = out.list.length
  out.list.sort((a, b) => (b.uc_count || 0) - (a.uc_count || 0) || (b.videos_count || 0) - (a.videos_count || 0))
  // 直接覆盖写：tmp+rename 需要删除旧文件，会被沙箱文件策略拒绝
  fs.writeFileSync(OUT_JSON, JSON.stringify(out))
  console.log('③ relay/uncensored_actresses.json：无码演员 ' + out.count + ' 位（判为女优 ' + isFem + ' · 男优/未知名 ' + isMale + '）')
  console.log('   样例：' + out.list.slice(0, 10).map(x => x.name + '(' + x.uc_count + ')').join('、'))
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
