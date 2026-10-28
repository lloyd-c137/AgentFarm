# Agent Farm 服务器

一个 Cloudflare Worker 加一个 D1 数据库，不用 Durable Objects。页面每 5 秒轮询一次。数据没变时服务器回 204，几乎不花额度。

```
Claude Code ──http hook──┐
Codex ──agent-farm.sh────┼─▶ /ingest/<来源>  ──▶ D1 (farms · devices · tasks)
                         │                           ▲
浏览器农场页 ◀── /api/farm?v=版本号 (轮询) ───────────┘
每分钟 Cron：30 分钟没上报 → 失联乌鸦；等你超过 24 小时 → 自动收获
```

## 本地跑起来

```sh
cd server
npm install
npm run db:local          # 建本地数据库
npm run dev               # http://localhost:8787 ，.dev.vars 里的 DEV_USER 充当登录用户
```

打开 `http://localhost:8787/setup.html`，生成钥匙，然后按页面上的说明把 Claude Code 或 Codex 接进来。直接双击打开 `index.html`，或者在网址后面加 `?demo`，跑的是演示模式。

## 部署到 Cloudflare

```sh
npx wrangler login
npx wrangler d1 create agent-farm      # 把打印出的 database_id 填进 wrangler.jsonc
npm run db:remote
npm run deploy                         # 得到 https://agent-farm.<你的子域>.workers.dev
```

## 当前线上状态

- 地址：https://agentfarm.lloydev.site （备用：https://agent-farm.lloyd666.workers.dev）
- 数据库：D1 `agent-farm-apac`，建在亚太（`--location apac`），离用户近；旧的美东库 `agent-farm` 已停用，确认无误后可删除。
- 账户：任何人都能在 `/login.html` 用邮箱 + 密码注册，每个账户各自一个农场，设备、任务、收获互不可见。
  - 密码用 PBKDF2-SHA256（10 万次、每人独立盐）保存；登录后发一个随机会话令牌放在 HttpOnly Cookie 里，数据库只存它的哈希，90 天有效。
  - 同一邮箱 15 分钟内输错 10 次会被锁 15 分钟；改密码会让其他浏览器全部退出。
  - 还没有邮箱验证和找回密码（需要接发信服务）。

## 以后换成 Cloudflare Access（可选，50 人以内免费；开启后账户登录自动停用）


1. 进入 Zero Trust → Access → Applications → Add → Self-hosted。
2. 域名填上面的 workers.dev 地址，或者你自己绑定的域名。
3. 策略选 Allow，邮箱填你和队友的。
4. 加一条 Bypass 规则，路径填 `/ingest/*`。设备是用钥匙上报的，不走浏览器登录。
5. 把应用的 AUD 和团队域名（`<team>.cloudflareaccess.com`）填进 `wrangler.jsonc` 的 `ACCESS_AUD` 和 `ACCESS_TEAM_DOMAIN`，再执行一次 `npm run deploy`。

线上不要设置 `DEV_USER`。一旦设置，所有人都会被当成同一个用户。

## 接口

| 路径 | 用途 |
|---|---|
| `POST /ingest/{claude-code,codex,claude-web,chatgpt-web}` | 上报事件，需要 `Authorization: Bearer <钥匙>`。永远回空的 200，不替 AI 做任何决定。 |
| `GET /api/farm?v=N&tz=分钟` | 农场当前状态。版本号没变时回 204。 |
| `GET/POST /api/devices`、`DELETE /api/devices/:id` | 管理设备钥匙。数据库只存钥匙的哈希。 |
| `POST /api/tasks/:id/harvest` | 手动收获。 |

所有写操作必须带请求头 `X-Agent-Farm: 1`，用来防止跨站伪造请求。

浏览器扩展（Claude / ChatGPT 网页聊天）还没做。到时它会往 `/ingest/claude-web`、`/ingest/chatgpt-web` 发送简化事件：`{event: prompt|stop|end, session_id, title?, url?}`。
