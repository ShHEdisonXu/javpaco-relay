#!/usr/bin/env node
/* 全量女优头像回填：读 roster.json（{mnid,name}[]）+ relay/rankings.json 榜上 id，
 * 凡缺 avatars/<mnid>.jpg 的，逐个抓 minnano 资料页 og:image 存盘。
 * 用法：node tools/roster-avatars.js [limit]   —— limit 为数字（每轮上限，默认 400）、
 *       full/0 表示不限量（一次性全量回填，约 2.4 万个，Actions 里 1~2 小时）。
 * 无第三方依赖，Node 18+ 自带 fetch。 */
const fs = require('fs')
const path = require('path')

const MN_BASE = 'https://www.minnano-av.com/'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const RELAY_DIR = path.join(__dirname, '..', 'relay')
const AVA_DIR = path.join(RELAY_DIR, 'avatars')
const TIMEOUT = 20000

const limit = (() => {
  const a = process.argv[2]
  if (!a) return 400
  if (/^0$/i.test(a) || /^full$/i.test(a)) return Infinity
  return parseInt(a, 10) || 400
})()

async function get(url, binary) {
  const rs = await fetch(url, {
    headers: { 'user-agent': UA, referer: MN_BASE, accept: binary ? 'image/jpeg,image/png,*/*' : 'text/html' },
    signal: AbortSignal.timeout(TIMEOUT)
  })
  if (!rs.ok) throw new Error('HTTP ' + rs.status + ' ' + url)
  return binary ? Buffer.from(await rs.arrayBuffer()) : await rs.text()
}
const isImg = b => !!(b && b.length > 2048 && ((b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50)))
const pool = async (items, n, fn) => {
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { await fn(items[k], k) } catch (_) {} }
  }))
}

;(async () => {
  fs.mkdirSync(AVA_DIR, { recursive: true })
  const roster = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'relay', 'roster.json'), 'utf8'))
  const ids = []
  for (const r of roster) if (r && r.mnid) ids.push(String(r.mnid))
  try {   // 榜上 id 并入：新上榜的女优 roster 快照可能还没收录
    const rk = JSON.parse(fs.readFileSync(path.join(RELAY_DIR, 'rankings.json'), 'utf8'))
    for (const k of ['day', 'week', 'month']) for (const r of (rk[k] || [])) if (r.id && !ids.includes(String(r.id))) ids.push(String(r.id))
  } catch (_) {}
  const miss = ids.filter(id => {
    const f = path.join(AVA_DIR, id + '.jpg')
    return !(fs.existsSync(f) && fs.statSync(f).size > 2048)
  })
  const todo = miss.slice(0, limit)
  console.log('名册 ' + ids.length + ' · 缺头像 ' + miss.length + ' · 本轮抓 ' + todo.length + (limit === Infinity ? '（全量）' : ''))
  let ok = 0, fail = 0
  await pool(todo, 4, async (id, i) => {
    try {
      const html = await get(MN_BASE + 'actress' + id + '.html')
      const img = (html.match(/property="og:image" content="([^"]+)"/) || html.match(/<img[^>]+class="[^"]*actress[^"]*"[^>]+src="([^"]+)"/) || [])[1]
      if (!img) { fail++; return }
      const b = await get(img.startsWith('http') ? img : MN_BASE.replace(/\/$/, '') + img, true).catch(() => null)
      if (isImg(b)) { fs.writeFileSync(path.join(AVA_DIR, id + '.jpg'), b); ok++ } else { fail++ }
    } catch (_) { fail++ }
    if ((i + 1) % 100 === 0) console.log('进度 ' + (i + 1) + '/' + todo.length + ' · ok=' + ok)
  })
  console.log('完成：新抓 ' + ok + ' · 失败 ' + fail + ' · 名册仍缺 ' + (miss.length - ok))
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
