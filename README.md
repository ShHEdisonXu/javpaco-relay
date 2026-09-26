# javpaco-relay

JAVPACO 的公共中转数据仓库（无需任何 token，`raw.githubusercontent.com` / `cdn.jsdelivr.net` 国内直连可达）：

- `rankings.json` — minnano 日/周/月女优榜（每日北京时间 05:30 由 GitHub Actions 抓取更新）
- `avatars/<mnid>.jpg` — 榜上女优头像

抓取脚本：`tools/rank-relay.js`（零依赖，Node 18+）。数据由 `.github/workflows/rank-relay.yml` 每日自动提交。
