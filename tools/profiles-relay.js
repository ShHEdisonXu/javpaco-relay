#!/usr/bin/env node
/* profiles-relay.js — minnano 全量资料页回填（必须在 GitHub Actions 上跑：家宽 SNI 阻断、
 * 数据中心代理被站方 WAF 403，只有 Actions 机房 IP 能直连 minnano-av.com）。
 *
 * 读 relay/roster.json，对每条带 mnid 的记录抓 actress<mnid>.html，用与主仓
 * tools/minnano-sync.js parseProfilePage 同一套口径解析并「只填空、不覆盖」：
 *   愛称(nick) / 公式サイト(official) / 別名(alias) / 现用名(mcanon) /
 *   生年月日・身高・三围・罩杯・血型・出身地・爱好・出演期间・出道作品・事务所・博客 /
 *   标签(tags) / 相关女优(rel) / 头像路径(mimg)
 *
 * 背景：2026-10-02 发现主仓旧解析器漏掉「愛称」「公式サイト」两栏，且名册里大量
 * 改名女优（如 小倉七海 → 兒玉七海）缺 mcanon → 前端按现用名搜不到人。
 *
 * 用法：
 *   node tools/profiles-relay.js full     # 全量 ~2.5 万页（Actions 约 1~2 小时）
 *   node tools/profiles-relay.js          # 增量：只抓「缺 nick 且缺 official」的（每日顺带）
 *   ONLY=698899,677238 node tools/profiles-relay.js   # 只抓指定 mnid（无视缓存）
 * 断点续跑：缓存 $TMPDIR/profiles-relay.json（每 200 条落盘一次）。
 * 无第三方依赖，Node 18+ 自带 fetch。 */
const fs = require('fs')
const path = require('path')

const MN_BASE = 'https://www.minnano-av.com/'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const ROSTER = path.join(__dirname, '..', 'relay', 'roster.json')
const TMP = path.join(process.env.TMPDIR || '/tmp', 'javpaco-profiles-relay')
const CACHE = path.join(TMP, 'profiles-relay.json')
const CONC = 8
const DELAY = 150          // ms，实测 0.55s 间隔无限流，留足余量
const PROF_TTL = 20 * 3600 * 1000

const FULL = /^full$/i.test(process.argv[2] || '') || process.argv[2] === '0'
const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean)

const dec = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim()
const strip = s => dec(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
const dropEmpty = (k, v) => (v === '' || v === null || (Array.isArray(v) && v.length === 0) ? undefined : v)
const sleep = ms => new Promise(s => setTimeout(s, ms))
/* 名字归一（与主仓 acNorm 同思路，去掉 name-map 依赖：全角→半角、片假名→平假名、剔符号） */
const cnorm = s => String(s || '')
  .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ')
  .replace(/[\u30A1-\u30F6\u31F0-\u31FF]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
  .replace(/[^\u3040-\u30FF\u4E00-\u9FFF\u3400-\u4DBFa-z0-9]/gi, '')
  .toLowerCase()

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, referer: MN_BASE, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(25000)
      })
      if (r.status === 200) return await r.text()
      if (r.status >= 500) { await sleep(1500 * (i + 1)); continue }
      return ''
    } catch (_) { await sleep(1500 * (i + 1)) }
  }
  return ''
}

/* 与主仓 tools/minnano-sync.js parseProfilePage 同一套口径（改动必须两边同步） */
function parseProfilePage(html) {
  const kv = {}
  const alias = []
  for (const m of html.matchAll(/<td[^>]*>\s*<span>([^<]+)<\/span>([\s\S]*?)<\/td>/g)) {
    const k = strip(m[1]), v = strip(m[2])
    if (!k || !v) continue
    if (k === '別名') { alias.push(v.split('（')[0].split('(')[0].trim()); continue }
    if (!kv[k]) kv[k] = v
  }
  const size = kv['サイズ'] || ''
  const cupRaw = (size.match(/([A-ZＡ-Ｚ])\s*カップ/) || [])[1] || ''
  const cup = cupRaw.replace(/[Ａ-Ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  const birthday = (kv['生年月日'] || '').replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/, (_, y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`).split(/[\s（(]/)[0]
  const canon = strip((html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '').split(/（|\(|AV女優/)[0].trim()
  const tags = []
  const tagBlock = (html.match(/<span>タグ<\/span>[\s\S]*?<div class="tagarea">([\s\S]*?)<\/td>/) || [])[1] || ''
  for (const m of tagBlock.matchAll(/tag_a_id=(\d+)[^>]*>([\s\S]*?)<\/a>/g)) {
    const n = dec(m[2])
    if (n) tags.push([m[1], n])
  }
  const rel = []
  const ri = html.indexOf('をチェックした人が見ている女優')
  if (ri > -1) {
    const seg = html.slice(ri, ri + 6000)
    for (const m of seg.matchAll(/href="(?:\/)?actress(\d+)\.html">\s*<img[^>]*title="([^"]*)"/g)) {
      const n = dec(m[2])
      if (n && !rel.some(x => x.id === m[1])) rel.push({ id: m[1], name: n })
      if (rel.length >= 10) break
    }
  }
  const img = (html.match(/src="(?:\/)?(p_actress[^"]+?\.jpg)/) || [])[1] || ''
  return {
    canon, birthday,
    height: (size.match(/T(\d+)/) || [])[1] || '',
    breast: (size.match(/B(\d+)/) || [])[1] || '',
    cup,
    waist: (size.match(/W(\d+)/) || [])[1] || '',
    hip: (size.match(/H(\d+)/) || [])[1] || '',
    shoe: (size.match(/S([\d.]+)/) || [])[1] || '',
    blood: kv['血液型'] || '', place: kv['出身地'] || '', hobby: kv['趣味・特技'] || '',
    period: kv['AV出演期間'] || '', debut: kv['デビュー作品'] || '',
    agency: kv['所属事務所'] || '', blog: kv['ブログ'] || '',
    nick: kv['愛称'] || '', official: kv['公式サイト'] || '',
    img: img ? MN_BASE + img : '',
    alias: alias.filter(Boolean), tags, rel
  }
}

const NEED = ['birthday', 'height', 'breast', 'cup', 'waist', 'hip', 'shoe', 'blood', 'place',
  'hobby', 'period', 'debut', 'agency', 'blog', 'nick', 'official', 'mcanon', 'mimg']
const isEmpty = v => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)

;(async () => {
  const roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8'))
  fs.mkdirSync(TMP, { recursive: true })
  let cache = {}
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) } catch (_) {}

  /* 待抓名单：ONLY 指定 > full 全量 > 增量（缺 nick/official 或整条没档案） */
  let stale
  if (ONLY.length) stale = roster.filter(a => a && a.mnid && ONLY.includes(String(a.mnid)))
  else if (FULL) stale = roster.filter(a => a && a.mnid)
  else stale = roster.filter(a => a && a.mnid && (!a.nick || !a.official))
  const targets = stale.filter(a => {
    const c = cache[a.mnid]
    return !c || Date.now() - c.fetchedAt > PROF_TTL
  })
  console.log(`名册 ${roster.length} · 有 mnid ${roster.filter(a => a && a.mnid).length} · 待抓 ${targets.length}${FULL ? '（全量）' : ONLY.length ? '（ONLY 指定）' : '（增量：缺 愛称/公式サイト）'}`)
  if (!targets.length) { console.log('无需抓取'); return }

  const idx = new Map()
  for (const a of targets) idx.set(String(a.mnid), a)
  let done = 0, ok = 0, fail = 0
  const t0 = Date.now()
  const saveCache = () => { try { fs.writeFileSync(CACHE, JSON.stringify(cache)) } catch (_) {} }
  const saveRoster = () => {
    const t = ROSTER + '.tmp'
    fs.writeFileSync(t, JSON.stringify(roster, dropEmpty))
    fs.renameSync(t, ROSTER)
  }
  let cursor = 0
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= targets.length) return
      const a = targets[i]
      const t = Date.now()
      let html = ''
      try { html = await get(MN_BASE + 'actress' + a.mnid + '.html') } catch (_) {}
      if (html) {
        const p = parseProfilePage(html)
        cache[a.mnid] = { fetchedAt: Date.now(), ok: true }
        ok++
        /* 只填空不覆盖：roster.json 是发给全部用户的兜底名册，手工修正过的值不许被冲掉 */
        if (p.canon && cnorm(p.canon) !== cnorm(a.name) && !a.mcanon) a.mcanon = p.canon
        for (const f of NEED) if (isEmpty(a[f]) && !isEmpty(p[f])) a[f] = p[f]
        if (!isEmpty(p.img) && isEmpty(a.mimg)) a.mimg = p.img
        if (isEmpty(a.alias) && p.alias.length) a.alias = p.alias
        if (isEmpty(a.tags) && p.tags.length) a.tags = p.tags
        if (isEmpty(a.rel) && p.rel.length) a.rel = p.rel.map(x => String(x.id || '')).filter(Boolean)
        if (!a.msrc) a.msrc = MN_BASE + 'actress' + a.mnid + '.html'
      } else {
        cache[a.mnid] = { fetchedAt: Date.now(), ok: false }
        fail++
      }
      done++
      if (done % 200 === 0) { saveCache(); saveRoster() }
      if (done % 100 === 0) {
        const el = Math.round((Date.now() - t0) / 1000)
        const eta = Math.round(el / done * (targets.length - done))
        console.log(`  进度 ${done}/${targets.length} · 成功 ${ok} 失败 ${fail} · ${el}s，剩余约 ${Math.floor(eta / 60)}m${eta % 60}s`)
      }
      if (DELAY) await sleep(Math.max(0, DELAY - (Date.now() - t)))
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker))
  saveCache(); saveRoster()
  console.log(`完成：成功 ${ok} · 失败 ${fail} · 耗时 ${Math.round((Date.now() - t0) / 1000)}s`)
  console.log(`回填后：有 愛称 ${roster.filter(a => a && a.nick).length} · 有 公式サイト ${roster.filter(a => a && a.official).length} · 有 mcanon ${roster.filter(a => a && a.mcanon).length}`)
})().catch(e => { console.error('FAIL:', e.stack || e.message); process.exit(1) })
