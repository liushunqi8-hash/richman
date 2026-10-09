# 大富翁 Richman · 世界版

在线玩：https://richman.liushunqi8.com

环游世界买地皮的大富翁游戏：28 格世界城市棋盘（纽约 / 上海 / 东京 / 伦敦……每个城市配地标实拍图），双骰子 + 滚动动画（同点再掷一次），集齐一国四城则对手踩中该国任意房产时收取你名下全区租金之和。

- 🤖 单机（打电脑 AI）
- 🌐 远程联机：创建房间拿 6 位房号，朋友输入房号加入（Cloudflare Durable Objects + WebSocket，服务器仲裁防作弊）

## 项目结构

```
shared/game-core.js      纯游戏逻辑（无 DOM），Node / Workers / 浏览器通用
shared/test-core.js      逻辑单测（node shared/test-core.js）
client-template.html     前端页面模板（主页 / 选形象 / 单机 / 联机房间 / 对战 UI）
worker-src.js            Cloudflare Worker + Durable Object 房间服务器
build-v3.js              打包脚本：拼 core + 头像 + 地标图 → dist/
deploy-do.py             部署脚本（带 DO binding，不带 migrations）
assets/                  玩家头像（webp）与城市地标图映射（landmarks.json）
```

旧版 v2（Python + Pyodide 单机版）代码保留在 `game.py` / `template.html` / `build.py` / `test_game.py`，仅作存档。

## 本地构建

```bash
node build-v3.js          # 生成 dist/worker.js 与 dist/index.html
node shared/test-core.js # 跑逻辑测试
```

## 部署

```bash
python3 deploy-do.py <CLOUDFLARE_ACCOUNT_ID> richman-game dist/worker.js
```

注意：

- 首次部署 Durable Object 需要 `new_sqlite_classes` migration（免费版要求）；
- 之后只改业务代码时**不要**带 migrations（同 tag 重复上传会 412），但必须带上 `ROOMS` binding，否则会清空绑定；
- 部署脚本走环境里的 Cloudflare 凭证，不在仓库里放任何密钥。
