#!/usr/bin/env node
/* JavDB 全量演员资料中转（GitHub Actions 内运行，机房直连国内线路无墙）：
 * 1. 从「最新入库」影片列表反推全部演员（JavDB 没有演员目录端点，v1/actors 返回空）
 * 2. 每个演员取 v1/actors/{id} 完整资料 + 头像
 * 3. 性别判据：JavDB 女优有三围（bust/waist/hips），男优这些字段全空 —— JavDB 自身的数据习惯
 * 4. 写 relay/actors_full.json（男女统一，含 gender）+ relay/avatars_jdb/<id>.jpg
 *
 * 服务端（server.js）用它给演员页提供「正确的 JavDB 头像与资料」：
 * 库里有演员用库内资源，库里没有的用这份数据兜底。
 * 无第三方依赖，Node 18+ 自带 fetch。 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

/* ---- JavDB 移动端 API：国内线路 + 应用级签名（照抄 server.js 的 jdbSign） ---- */
const JDB_LINES = ['https://apidd.spthgb.com', 'https://apidd.czssdgz.com', 'https://jdforrepam.com']
const JDB_P1 = '71cf27bb3c0bcdf207b64abecddc970098c7421ee7203b9cdae54478478a199e7d5a6e1a57691123c1a931c057842fb73ba3b3c83bcd69c17ccf174081e3d8aa'
const JDB_P2 = 'lpw6vgqzsp'
function jdbSign() {
  const ts = Math.floor(Date.now() / 1000)
  return ts + '.' + JDB_P2 + '.' + crypto.createHash('md5').update(String(ts) + JDB_P1).digest('hex')
}

/* 产物目录：Actions 里脚本在 tools/ 下跑，仓库根的 relay/ 在上一层；本地自测则与脚本同级。
 * ⚠️ 之前默认写 path.join(__dirname,'relay') → Actions 里变成 tools/relay（不存在）→ ENOENT 整个 job 失败。 */
const RELAY_DIR = process.env.RELAY_DIR ||
  (path.basename(__dirname) === 'tools' ? path.join(__dirname, '..', 'relay') : path.join(__dirname, 'relay'))
const AVA_DIR = path.join(RELAY_DIR, 'avatars_jdb')
const OUT_JSON = path.join(RELAY_DIR, 'actors_full.json')
const TIMEOUT = 20000
const MOVIE_PAGES = +(process.env.MOVIE_PAGES || 20)     // 翻多少页影片列表（每页 30 部）
const AVA_CONC = +(process.env.AVA_CONC || 6)            // 头像并发
const LINE_OK_K = 'actors_full_line_ok'
let LINE_OK = ''

/* 线路成功记录（跨次续跑，避免每次重探） */
function loadLine() { try { LINE_OK = fs.readFileSync(path.join(RELAY_DIR, LINE_OK_K), 'utf8').trim() } catch (_) {} }
function saveLine() { try { fs.writeFileSync(path.join(RELAY_DIR, LINE_OK_K), LINE_OK) } catch (_) {} }

async function jdbGet(rel, binary) {
  const order = LINE_OK && JDB_LINES.includes(LINE_OK) ? [LINE_OK].concat(JDB_LINES.filter(x => x !== LINE_OK)) : JDB_LINES
  let lastErr = null
  for (const base of order) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT)
    try {
      const r = await fetch(base + '/api/' + rel, {
        signal: ac.signal,
        headers: { jdsignature: jdbSign(), 'User-Agent': 'Dart/3.5 (dart:io)', 'Accept-Language': 'zh-TW', Accept: binary ? '*/*' : 'application/json' }
      })
      if (!r.ok) throw new Error(base + ' → ' + r.status)
      if (binary) { LINE_OK = base; saveLine(); return Buffer.from(await r.arrayBuffer()) }
      const j = await r.json()
      if (j && j.success === 0) throw new Error(j.message || 'API 返回失败')
      LINE_OK = base; saveLine()
      return j
    } catch (e) { lastErr = e } finally { clearTimeout(timer) }
  }
  throw lastErr || new Error('JavDB 线路均不可用')
}

/* 图片走绝对地址直连（不拼 /api/）：JavDB 图床返回的是加密字节流，需解密 */
async function imgGet(url) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT)
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Dart/3.5 (dart:io)', Referer: new URL(url).origin + '/' } })
    if (!r.ok) throw new Error('图床 ' + r.status)
    return Buffer.from(await r.arrayBuffer())
  } finally { clearTimeout(timer) }
}
function imgMaybeDecrypt(buf) {
  if (!buf || buf.length < 2) return buf
  const head4 = buf.subarray(0, 4).toString('binary')
  const known = (buf[0] === 0xFF && buf[1] === 0xD8) || head4 === 'RIFF' || head4 === 'GIF8'
    || buf.subarray(0, 8).toString('binary') === '\x89PNG\r\n\x1a\n' || head4 === '\x00\x00\x01\x00' || head4 === 'ftyp'
  if (known) return buf
  const key = buf[0]
  const out = Buffer.allocUnsafe(buf.length - 1)
  for (let i = 1; i < buf.length; i++) out[i - 1] = buf[i] ^ key
  return out
}
const IMG_HOST_OK = /(^|\.)(spfcas\.com|jdbstatic\.com|javdb\d*\.com)$/i
const isImg = b => !!(b && b.length > 2048 && ((b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50)))

const pool = async (items, n, fn) => {
  const out = []; let i = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k) } catch (_) { out[k] = null } }
  }))
  return out
}

/* ---- 断点续跑：已抓到的演员直接复用，只补新的 ---- */
function loadPrev() {
  try { return JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')) || { list: [] } } catch (_) { return { list: [] } }
}

/* 名字归一化（照抄 server.js onNorm + onKana）：用于精确匹配搜索结果。
 * ⚠️ 必须同时做「片假名/汉字 → 平假名」归一：名册写「松本いちか」、JavDB 写「松本一香」，
 * 不归一会漏判性别（松本一香是女优）。 */
const onKana = s => String(s || '').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
const onNorm = s => onKana(String(s || '')).toLowerCase().replace(/[\s　・·,，、/]+/g, '')
/* 逐个搜名字 → 命中 actor（归一化精确匹配，防抓错人：搜索会带出同名/别名干扰项） */
function pickActor(actors, name) {
  const n = onNorm(name)
  for (const a of actors) {
    const names = [a.name, a.name_zht, a.other_name].filter(Boolean).join(',')
    for (const x of String(names).split(',')) if (x && onNorm(x) === n) return a
  }
  return null
}

/* minnano 原图直取（不是 JavDB 图床，不加密，就是普通 https 图片） */
async function plainImgGet(url) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT)
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', Referer: 'https://www.minnano-av.com/' }
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return Buffer.from(await r.arrayBuffer())
  } finally { clearTimeout(timer) }
}

/* 名册里没头像的女优 → JavDB 补资料+头像。
 * 背景：名册 24959 位里 1141 位（4.6%）icon 为空，前端 acAvatar 拿不到 icon 就拿影片封面顶着，
 * 用户看到的就是「很多演员小头像没有，用的却是影片封面」。
 * 三级来源：JavDB 图 →（JavDB 没图时）名册 mimg 的 minnano 原图 → 都没有才真的没图。
 * 实测：400 位缺头像女优里 JavDB 只 13% 有图，但 276 位名册存着 minnano 原图地址 → 大部分能补上。 */
async function fixActressesWithoutIcon(byId) {
  const FIX_OUT = path.join(RELAY_DIR, 'actress_fix.json')
  const ROSTER = path.join(RELAY_DIR, '..', 'actresses.json')
  let roster = []
  try { roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8')) || [] } catch (_) {}
  const byName = new Map(roster.map(a => [a && a.name, a]))
  const need = roster.filter(a => a && a.name && !a.icon)
    .sort((x, y) => (y.videoCount || 0) - (x.videoCount || 0))
    .slice(0, +(process.env.FIX_LIMIT || 400))          // 高作品数优先
  if (!need.length) { console.log('⑤ 无名册数据，跳过女优补图'); return }

  // 续跑：已有记录直接复用
  let fix = {}
  try { fix = JSON.parse(fs.readFileSync(FIX_OUT, 'utf8')) || {} } catch (_) {}
  const todo = need.filter(a => !fix[a.name])
  console.log('⑤ 名册无头像女优 ' + need.length + ' 位（已补 ' + (need.length - todo.length) + '，本次查 ' + todo.length + '）')

  let gotJdb = 0, gotMn = 0
  await pool(todo, 4, async a => {
    const rec = { name: a.name, mimg: a.mimg || '', mnid: a.mnid || '', rosterWorks: a.videoCount || 0, at: Date.now() }
    try {
      const j = await jdbGet('v2/search?q=' + encodeURIComponent(a.name) + '&type=actor&page=1')
      const arr = ((j || {}).data || {}).actors || []
      const hit = pickActor(arr, a.name)
      if (hit && hit.id) {
        const d = await jdbGet('v1/actors/' + encodeURIComponent(hit.id))
        const ac = (((d || {}).data || {}).actor || {})
        if (ac.id && ac.name) {
          rec.id = ac.id
          rec.jname = ac.name
          rec.name_zht = ac.name_zht || ''
          rec.other_name = ac.other_name || ''
          rec.avatar_url = ac.avatar_url || ''      // JavDB 有图就用它
          rec.videos_count = ac.videos_count != null ? ac.videos_count : ''
          rec.birthday = ac.birthday || ''
          rec.height = ac.height != null ? ac.height : ''
          rec.bust = ac.bust != null ? ac.bust : ''
          rec.cup = ac.cup || ''
          rec.waist = ac.waist != null ? ac.waist : ''
          rec.hips = ac.hips != null ? ac.hips : ''
          rec.birthplace = ac.birthplace || ''
          if (ac.avatar_url) gotJdb++
        }
      }
    } catch (_) {}
    fix[a.name] = rec
  })
  // ⚠️ 不用 renameSync：沙箱/部分文件系统会拦「覆盖式 rename」，直接 writeFileSync 覆盖
  fs.writeFileSync(FIX_OUT, JSON.stringify({ fetchedAt: Date.now(), count: Object.keys(fix).length, map: fix }))
  const withJdb = Object.values(fix).filter(x => x.avatar_url).length
  const withMn = Object.values(fix).filter(x => !x.avatar_url && x.mimg).length
  console.log('   relay/actress_fix.json：共 ' + Object.keys(fix).length + ' 条 · JavDB 图 ' + withJdb + '（本次 +' + gotJdb + '）· JavDB 无图但名册有 minnano 原图 ' + withMn)
}

/* ---- 性别判定 ----
 * ⚠️ 不能用「JavDB 有没有三围」来判：实测 JavDB 只给少数女优填三围（116 位里仅 7 位），
 * 880 个被判「男优」里有 623 个（71%）其实是女优（安倍亜沙美/AIKA/松本一香…）—— 判据失效。
 * 可靠做法：**名册（minnano 全量女优，2.5 万）反查** —— 名字（含别名，归一化）命中名册 = 女优，
 * 否则 = 男优。名册没有的（比如 JavDB 独有的男优）就是男优，逻辑闭合。 */
let FEM_NAMES = null
function loadFemaleNames() {
  if (FEM_NAMES) return FEM_NAMES
  FEM_NAMES = new Set()
  /* ⚠️ 优先读 relay/female_names.json（精简版名册，0.75MB，已进仓库）：
   * GitHub Actions 仓库里没有 16MB 的 actresses.json，没有它名册反查会整个失效
   * → 新抓的演员全被判成男优（2026-10-07 实测一次跑进去 21 个假男优）。 */
  let roster = []
  try {
    const fn = JSON.parse(fs.readFileSync(path.join(RELAY_DIR, 'female_names.json'), 'utf8')) || {}
    roster = (fn.names || []).map(n => ({ name: n }))
  } catch (_) {}
  if (!roster.length) {
    const ROSTER = path.join(RELAY_DIR, '..', 'actresses.json')
    try { roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8')) || [] } catch (_) {}
  }
  const push = n => { const k = onNorm(n); if (k) FEM_NAMES.add(k) }
  for (const a of roster) {
    if (!a || !a.name) continue
    push(a.name)
    ;[a.name_ja, a.name_zh, a.name_en].forEach(n => n && push(n))
    if (Array.isArray(a.alias)) a.alias.forEach(push)
  }
  return FEM_NAMES
}
/* 回写 relay/female_names.json：把本次判定为女优的名字（含别名）并进精简名册。
 * 名册每天会漂移（新出道的女优），不回写的话 Actions 侧的反查名单会越用越旧，
 * 新演员就又只能靠「不是女优就是男优」瞎猜。 */
function updateFemaleNames(list) {
  try {
    const p = path.join(RELAY_DIR, 'female_names.json')
    const names = new Set()
    try { ((JSON.parse(fs.readFileSync(p, 'utf8')) || {}).names || []).forEach(n => names.add(n)) } catch (_) {}
    const before = names.size
    for (const a of list) {
      if (!a || a.gender !== 'f') continue
      ;[a.name, a.name_zht].concat(String(a.other_name || '').split(/[,，、]/)).forEach(n => {
        n = String(n || '').trim()
        if (n && n.length < 60) names.add(n)
      })
    }
    if (names.size !== before) {
      fs.writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), source: 'minnano-roster+javdb-verified', count: names.size, names: [...names] }))
      console.log('   relay/female_names.json：' + before + ' → ' + names.size + ' 个女优名字')
    }
  } catch (_) {}
}

function genderOf(a) {
  const fem = loadFemaleNames()
  const keys = [a.name, a.name_zht].concat(String(a.other_name || '').split(/[,，、]/))
  for (const k of keys) { if (k && fem.has(onNorm(k))) return { gender: 'f', rosterHit: true } }
  // 名册没命中 → 「可能是男优」，但必须过网页版复核：
  // 实测名册反查漏判率极高（欧美/无码厂演员大多不在 minnano 名册里），
  // 第一版 256 个「男优」里 152 个（59%）其实是女优。
  return { gender: 'm', rosterHit: false }
}

/* ---- 性别复核：JavDB 网页版演员页的 section-meta（权威判据） ----
 * https://javdb.com/actors/<id> 里 <span class="section-meta"> 的内容：
 *   男优页 → 「男優, 5415 部影片」     女优页 → 「81 部影片」（不带性别字样）
 * ⇒ 规则：所有 section-meta 里有「男優」= 男优，没有 = 女优。
 * ⚠️ 必须 matchAll：section-meta 有多个，第一个常是**别名标签**
 *   （鮫島页面的「鮫島健介」、黒田悠斗的「黒田将稔…」），只取第一个会把真男优判成女优。
 * ⚠️ GitHub Actions 拿不到：javdb.com 挂在 Cloudflare 后面，机房 IP 一律 403「Just a moment...」
 *   （2026-10-07 实测：Actions 里 curl code=403，本地/家庭宽带直连 200）。所以 Actions 侧
 *   性别主要靠 relay/female_names.json 的名册反查，网页版只作为本地补充手段。
 * 拿不到页面时返回 null（保留名册反查的结果，不硬改）。 */
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const WEB_PROXY = process.env.WEB_PROXY || (process.env.WEB_GENDER_LOCAL ? 'http://127.0.0.1:1082' : '')
const WEB_ON = process.env.WEB_GENDER !== '0'
let WEB_DEAD = false          // 连续失败到阈值就整轮放弃，别傻等
let webFailStreak = 0
function webGenderOf(id) {
  if (WEB_DEAD) return null
  const cmd = `curl -s --max-time 25 ${WEB_PROXY ? '-x ' + WEB_PROXY + ' ' : ''}-A "${WEB_UA}" "https://javdb.com/actors/${id}"`
  let h = ''
  try {
    const env = { ...process.env }
    ;['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'].forEach(k => delete env[k])
    h = execSync(cmd, { encoding: 'utf8', timeout: 30000, env, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (_) { h = '' }
  const metas = [...String(h).matchAll(/section-meta">([^<]+)</g)].map(x => x[1])
  if (!metas.length) {
    if (++webFailStreak >= 15) { WEB_DEAD = true; console.log('   ⚠ 网页版连续 15 次取不到（被墙/风控），本轮放弃复核，保留名册反查结果') }
    return null
  }
  webFailStreak = 0
  return metas.some(t => /男優/.test(t)) ? 'm' : 'f'
}

;(async () => {
  fs.mkdirSync(AVA_DIR, { recursive: true })
  loadLine()

  /* ① 翻影片列表，收集演员 id → 名字
   * JavDB 没有演员目录端点（v1/actors 返回空、网页版也不支持性别筛选），只能从影片反推。
   * 三个维度一起翻（全部/有码/无码），覆盖面比单一 latest 大不少。 */
  console.log('① 翻影片列表反推演员…')
  const found = new Map()
  const SOURCES = [
    { label: '全部', q: 'type=all&sort_by=update' },
    { label: '有码', q: 'type=0&sort_by=update' },
    { label: '无码', q: 'type=1&sort_by=update' }
  ]
  outer:
  for (const src of SOURCES) {
    let stall = 0
    for (let page = 1; page <= MOVIE_PAGES; page++) {
      let list = []
      try {
        const j = await jdbGet('v1/movies/latest?filter_by=magnets&limit=30&page=' + page + '&' + src.q)
        list = ((j || {}).data || {}).movies || []
      } catch (e) { console.log('   ' + src.label + ' 第' + page + '页失败：' + e.message); break }
      if (!list.length) break
      const ids = list.map(m => m.id).filter(Boolean)
      const detail = await pool(ids, 8, async id => {
        try { const d = await jdbGet('v2/movies/' + id); return ((d || {}).data || {}).movie || {} } catch (_) { return null }
      })
      let added = 0
      for (const mv of detail) {
        for (const a of (mv && mv.actors) || []) {
          if (a && a.id && a.name && !found.has(a.id)) { found.set(a.id, a.name); added++ }
        }
      }
      if (page % 10 === 0 || added === 0) console.log('   ' + src.label + ' 第' + page + '页 → 累计 ' + found.size + '（本页新增 ' + added + '）')
      // 该维度连续两页没新增演员 → 翻完了，换下一个维度
      stall = added === 0 ? stall + 1 : 0
      if (stall >= 2) break
    }
  }
  console.log('   影片反推共 ' + found.size + ' 个演员')

  /* ② 合并上次结果，只补没抓过的 */
  const prev = loadPrev()
  const byId = new Map((prev.list || []).map(a => [a.id, a]))
  const PREV_BY_ID = byId                                        // 安全阀用：还原上一版性别
  const MALE_BEFORE = (prev.list || []).filter(a => a.gender === 'm').length
  const todo = [...found.keys()].filter(id => !byId.get(id))
  console.log('② 已有 ' + byId.size + ' 个，需新抓 ' + todo.length + ' 个')

  let done = 0
  await pool(todo, 4, async id => {
    let a = null
    try { a = ((await jdbGet('v1/actors/' + encodeURIComponent(id))) || {}).data || {} } catch (_) { return }
    const ac = a.actor || {}
    if (!ac.id || !ac.name) return
    // 性别：名册命中 = 女优（可靠）；没命中 → 先标 pending，稍后统一过网页版复核
    const g = genderOf(ac)
    byId.set(id, {
      id: ac.id,
      name: ac.name || '',
      name_zht: ac.name_zht || '',
      other_name: ac.other_name || '',
      gender: g.gender,
      genderSource: g.rosterHit ? 'roster' : 'pending-web',
      avatar_url: ac.avatar_url || '',
      birthday: ac.birthday || '',
      age: ac.age != null ? ac.age : '',
      blood_type: ac.blood_type || '',
      height: ac.height != null ? ac.height : '',
      bust: ac.bust != null ? ac.bust : '',
      cup: ac.cup || '',
      waist: ac.waist != null ? ac.waist : '',
      hips: ac.hips != null ? ac.hips : '',
      birthplace: ac.birthplace || '',
      videos_count: ac.videos_count != null ? ac.videos_count : '',
      twitter_id: ac.twitter_id || '',
      instagram_id: ac.instagram_id || '',
      tags: (a.tags || []).map(t => t.name).filter(Boolean),
      source_url: 'https://javdb.com/actors/' + ac.id
    })
    done++
    if (done % 20 === 0) console.log('   新抓 ' + done + '/' + todo.length)
  })

  /* ②b 性别复核：本次新抓且名册没命中的，逐个问网页版 section-meta。
   * 旧记录（已在文件里）性别已定，不重复问，避免每天全量重跑 1000 次请求。 */
  const pending = todo.map(id => byId.get(id)).filter(r => r && r.genderSource === 'pending-web')
  if (WEB_ON && pending.length) {
    console.log('②b 性别复核（网页版 section-meta）：' + pending.length + ' 位…')
    await pool(pending, 8, async r => {
      const g = webGenderOf(r.id)
      if (g) { r.gender = g; r.genderSource = 'javdb-web-section-meta' }
      else r.genderSource = r.genderSource === 'pending-web' ? 'roster-heuristic' : r.genderSource
    })
    const fixF = pending.filter(r => r.gender === 'f').length
    console.log('   复核结果：女优 ' + fixF + ' · 男优 ' + (pending.length - fixF) + (WEB_DEAD ? '（网页版不可用，部分保留名册反查）' : ''))
  }

  const list = [...byId.values()].sort((a, b) => (Number(b.videos_count) || 0) - (Number(a.videos_count) || 0))
  const out = {
    fetchedAt: Date.now(),
    source: 'javdb',
    count: list.length,
    female: list.filter(a => a.gender === 'f').length,
    male: list.filter(a => a.gender === 'm').length,
    genderSource: 'javdb-web-section-meta+roster',
    list
  }

  /* ⚠️ 安全阀：名册（female_names.json）读不到 + 网页版也取不到 → 本次新增的性别全是瞎猜，
   * 会把一批女优写进「男优」tab。这种情况只更新资料、不动名单：还原成上一版的性别。 */
  const FEM_COUNT = loadFemaleNames().size
  if (WEB_DEAD && !FEM_COUNT && (out.male - MALE_BEFORE > 5)) {
    console.log(`⚠ 名册缺失且网页版不可用 → 本次新增的 ${out.male - MALE_BEFORE} 位性别不可信，按上一版还原，不写入新性别`)
    for (const r of pending) { const o = PREV_BY_ID.get(r.id); if (o) { r.gender = o.gender; r.genderSource = o.genderSource || 'prev' } else { r.gender = 'f'; r.genderSource = 'unverified-default-f' } }
    out.female = list.filter(a => a.gender === 'f').length
    out.male = list.filter(a => a.gender === 'm').length
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(out))
  updateFemaleNames(list)
  console.log('③ relay/actors_full.json 已生成：共 ' + out.count + ' 位（女优 ' + out.female + ' · 男优 ' + out.male + '）')

  /* ⑤ 名册里没头像的女优 → 用 JavDB 资料+头像补（名册 4.6% 缺头像，前端原来拿影片封面顶着）
   * 输出 relay/actress_fix.json：{ 名字: {id, avatar_url, videos_count, ...} }。
   * 只补「名册有这人、但 icon 为空」的那批 —— 有头像的不动，避免覆盖名册更好的图。 */
  await fixActressesWithoutIcon(byId)

  /* ④ 头像：男优全量（JavDB 图）+ 女优补图（JavDB 图，没有则用名册 minnano 原图） */
  let avOk = 0, avSkip = 0, avMiss = 0, avMn = 0
  let fixMap = {}
  try { fixMap = (JSON.parse(fs.readFileSync(path.join(RELAY_DIR, 'actress_fix.json'), 'utf8')) || {}).map || {} } catch (_) {}
  const avaList = [
    ...list.map(r => ({ id: r.id, avatar_url: r.avatar_url })),
    // 女优补图：JavDB 有图走 JavDB；没有则用名册存的 minnano 原图
    ...Object.values(fixMap).filter(x => x && (x.avatar_url || x.mimg))
      .map(x => ({ id: x.id || ('mn_' + (x.mnid || x.name)), avatar_url: x.avatar_url, mimg: x.mimg, isMn: !x.avatar_url }))
  ]
  await pool(avaList, AVA_CONC, async r => {
    if (!r.avatar_url && !r.mimg) { avMiss++; return }
    try {
      const f = path.join(AVA_DIR, r.id + '.jpg')
      if (fs.existsSync(f) && fs.statSync(f).size > 2048) { avSkip++; return }
      let b = null
      if (r.avatar_url) {
        const u = new URL(r.avatar_url)
        if (!IMG_HOST_OK.test(u.hostname)) { avMiss++; return }
        b = imgMaybeDecrypt(await imgGet(u.href))
      } else {
        // minnano 原图：普通 https 图片，不加密
        if (!/^https:\/\/www\.minnano-av\.com\//.test(r.mimg)) { avMiss++; return }
        b = await plainImgGet(r.mimg)
        avMn++
      }
      if (isImg(b)) { fs.writeFileSync(f, b); avOk++ } else avMiss++
    } catch (_) { avMiss++ }
  })
  console.log('④ 头像：新抓 ' + avOk + '（其中 minnano 原图 ' + avMn + '），已存在 ' + avSkip + '，无图/失败 ' + avMiss)
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
