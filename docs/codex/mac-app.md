# 任务：把 Agent Farm 做成本地 macOS 应用（Tauri 2）

你在 Agent Farm 仓库里工作。现在它是一个线上网站：像素农场游戏（`index.html`）+ Cloudflare Worker 后端（`server/`）。线上访问太慢，我们要做一个**完全跑在本机的 Mac 应用**：游戏窗口、数据库、接收 AI 工具事件的服务都在本机，不经过任何云服务。

请按下面的 M1 → M5 顺序实现。每完成一步：跑通该步的验收、提交一次 commit（信息写清楚做了什么），再进入下一步。某一步验收不过，先修好，不要跳过。

## 先读这些文件（理解现有行为，不要凭空重写）

- `index.html`：整个游戏（单文件 canvas）。搜索 `live mode` 一节：`goLive()`、`pollFarm()`、`applyFarm()`，这是前端接真实数据的地方。直接双击打开时它跑演示模式，这个行为必须保留。
- `server/src/worker.js`：后端参考实现。`normalize()`（把 Claude Code / Codex 的 hook 事件归一化）、`applyEvent()`（任务状态机）、`quality()`、`freeSlot()`、`sweep()`（失联与自动收获）是**行为规范**，要逐条移植，不要改变语义。
- `server/migrations/0001_init.sql`：`tasks` 表结构（本地版沿用 `tasks`，去掉多用户相关的表和字段）。
- `server/setup.html`、`server/px.css`、`server/farm-bg.js`：现有的像素风格页面，新页面要用同样的风格。
- `server/README.md`：现有接口说明。

## 目标架构

```
Claude Code / Codex ──(command hook)──▶ agent-farm-hook ──HTTP──▶ 本机服务 127.0.0.1:47321 ──▶ SQLite
                                         │ App 没开时写入 spool.jsonl，App 启动时回放
Tauri 窗口（WebKit）── 打开 http://127.0.0.1:47321/ ── 长轮询 /api/farm
菜单栏图标 + 系统通知 ◀── 状态变化
```

新代码放在 `desktop/`：

```
desktop/
  package.json            # 脚本：dev / build（调用 @tauri-apps/cli）
  ui/connect.html         # 「连接 AI 工具」页（像素风，复用 server/px.css 和 farm-bg.js）
  src-tauri/
    Cargo.toml  tauri.conf.json  capabilities/  icons/
    src/main.rs           # Tauri 入口：启动服务、窗口、菜单栏、通知、开机启动
    src/server.rs         # axum 路由
    src/store.rs          # rusqlite 存储 + 版本号
    src/farm.rs           # 状态机（从 worker.js 移植）+ 单元测试
    src/hooks.rs          # 安装/卸载 Claude Code 与 Codex 的 hook 配置
  hook/                   # 独立的小 crate：agent-farm-hook 可执行文件
```

## 硬性要求

1. **只监听 `127.0.0.1:47321`**。端口被占用时弹窗说明并退出，不要换随机端口（hook 配置和游戏存档都依赖这个固定地址）。
2. **数据目录** `~/Library/Application Support/AgentFarm/`：`farm.db`（SQLite）、`token`（首次启动生成 32 字节随机值，base64url，权限 600）、`spool.jsonl`、`bin/agent-farm-hook`。
3. **接口**（与 `server/` 保持兼容，前端才能少改）：
   - `POST /ingest/{claude-code|codex|claude-web|chatgpt-web}`：请求头 `Authorization: Bearer <token>`；无论事件是否被忽略都回**空的 200**；token 错回 401；body 上限 1 MB。
   - `GET /api/me` → `{"mode":"local"}`。
   - `GET /api/farm?v=N&tz=<分钟>&wait=<秒>`：返回格式与 `worker.js` 的 `/api/farm` 完全相同（`version, now, tasks[], shipped[], harvestToday, harvestWeek`）。`v` 等于当前版本时：没有 `wait` 回 204；有 `wait`（最大 30）就挂起，版本一变立即返回 200，超时回 204。用 `tokio::sync::watch` 广播版本号。
   - `POST /api/tasks/:id/harvest`：手动收获。
   - `GET /api/hooks`（两个工具的安装状态）、`POST /api/hooks/install {"target":"claude-code"|"codex"}`、`POST /api/hooks/uninstall {...}`。
   - 其他路径：提供游戏页面和 `connect.html` 等静态文件（用 `rust-embed` 或 `include_bytes!` 打进二进制）。游戏页直接用仓库根目录的 `index.html` 原文件。
4. **安全**：所有请求校验 `Host` ∈ {`127.0.0.1:47321`, `localhost:47321`}，否则 403（防 DNS 重绑定）；带 `Origin` 的请求，Origin 必须是这两个地址之一；所有非 GET 的 `/api/*` 必须带请求头 `X-Agent-Farm: 1`。
5. **状态机**：`farm.rs` 逐条对应 `worker.js` 的 `normalize`、`applyEvent`、`quality`、`freeSlot`、`sweep`（失联 30 分钟、等你超过 24 小时自动收获、收获记录保留 30 天）。每次有变化版本号 +1。每 60 秒跑一次 `sweep`。
6. **agent-farm-hook**（`desktop/hook/`，只用标准库，不引入 tokio）：
   - 用法 `agent-farm-hook <source>`；从 stdin 读完整个 JSON；从数据目录读 token；用 `std::net::TcpStream` 发 HTTP/1.1 POST 到 `127.0.0.1:47321/ingest/<source>`，连接和读写超时各 1 秒。
   - 发送失败（连不上、超时、非 2xx）时，把 `{"source":…,"body":<原始JSON>,"at":<毫秒>}` 作为一行追加到 `spool.jsonl`（文件超过 5 MB 时丢弃最旧的一半）。
   - **绝对不能向 stdout 或 stderr 输出任何内容，任何情况下都 exit 0**。Claude Code 会把 UserPromptSubmit 的 stdout 当成上下文，exit 2 会被当成拦截。为此写一个测试：用各种异常输入（空输入、非 JSON、服务没开）运行它，断言输出为空且退出码为 0。
   - App 每次启动时把打包进去的 hook 程序复制到 `bin/`（内容没变就不复制），hook 配置永远指向这个固定路径，这样 App 被移动后 hook 不失效。
7. **spool 回放**：App 启动、服务就绪后，按顺序回放 `spool.jsonl` 里的事件（用记录里的 `at` 作为事件时间），成功后清空文件。
8. **hook 安装**（`hooks.rs`）：
   - Claude Code：读取或新建 `~/.claude/settings.json`，在 `hooks` 下给 `UserPromptSubmit`、`PermissionRequest`、`Notification`、`PostToolUse`、`Stop`、`StopFailure`、`SessionEnd` 各加一条 `{"type":"command","command":"\"<数据目录>/bin/agent-farm-hook\" claude-code","timeout":5}`。
   - Codex：`~/.codex/hooks.json`，给 `UserPromptSubmit`、`PermissionRequest`、`PostToolUse`、`Stop`（timeout 5）、`Interrupt`、`SessionEnd`（timeout 3）各加一条，`command` 同上，参数为 `codex`。
   - 写之前备份为 `<原文件>.bak-<时间戳>`；只增删 command 里含 `agent-farm-hook` 的条目，其他内容和键顺序保持原样；重复安装不能产生重复条目。用 `serde_json` 的 `preserve_order` 特性。
   - 为合并和卸载写单元测试：已有其他 hook、空文件、文件不存在、重复安装、卸载后与原文件一致。
9. **前端改动**（`index.html`，改动越小越好）：
   - `goLive()` 读到 `/api/me` 返回 `mode === 'local'` 时：右下角按钮文字改为「连接 AI 工具」，链接到 `connect.html`；不做登录跳转。
   - `pollFarm()` 在本地模式下带 `wait=25`，收到响应后立即发起下一次请求；出错时等 2 秒再试。网页版（非 local）行为保持不变。
   - 直接双击打开 `index.html` 仍然是演示模式。
10. **`connect.html`**：像素风（同 `server/setup.html`）。两张卡片：Claude Code、Codex。每张显示是否已安装，以及「一键安装 / 移除」按钮。Codex 卡片提示：安装后在 Codex 里输入 `/hooks`，把 Agent Farm 的几条标记为信任。底部显示服务地址和数据目录，以及「返回农场」链接。
11. **菜单栏与窗口**（M4）：
    - 菜单栏图标用 `server/icons/favicon.svg` 的图案（生成 macOS 模板图标或彩色 22pt 图标），标题显示等你处理的任务数（0 时不显示）。
    - 菜单项：等你的任务（最多 5 条，点击打开窗口）、打开农场、连接 AI 工具、开机启动（勾选）、通知（勾选）、退出。
    - 窗口默认 1280×800，可缩放；点关闭只隐藏窗口，App 继续运行；在 Dock 里点图标重新显示窗口。
    - 任务进入 `approval`、`reply`、`error` 时发系统通知（`tauri-plugin-notification`），同一任务 2 分钟内只通知一次；点通知打开窗口。
    - 开机启动用 `tauri-plugin-autostart`，默认开启，开机启动时不弹出窗口。
12. **不要改动**：`server/` 下的网页版（它继续可部署）、游戏的画面和玩法、`index.html` 里与本地模式无关的代码。界面文字用中文。除了 localhost，不发起任何网络请求。

## 里程碑与验收

**M1 本机服务与状态机**（先不接 Tauri，做成可以单独运行的库 + 一个 `--serve` 调试入口）
- `cargo test` 全部通过。至少覆盖：新任务 → 请求授权 → 继续 → 等回复 → 失联 → 心跳恢复 → 会话结束收获（金星 / 银星 / 普通三种品质）；田地满了不再种；未知事件被忽略；token 错误回 401；Host 不对回 403。
- 写 `desktop/scripts/smoke.sh`：用 curl 发一组 Claude Code 和 Codex 的样例事件，打印 `/api/farm` 的结果。结果的字段和取值要与 `server/` 对同样事件的输出一致。

**M2 Tauri 外壳与游戏窗口**
- `npm run dev`（在 `desktop/`）打开窗口，能玩全部场景（农场、各房间、机场、伦敦 / 纽约 / 塞勒姆旅行）。
- 窗口开着时跑 smoke.sh，1 秒内田里出现作物、冒气泡、收获动画正常。
- 直接双击 `index.html` 仍是演示模式。

**M3 hook 接入**
- 在 connect.html 一键安装后，开一个真实的 Claude Code 会话发一句话，农场里出现新苗；Claude Code 请求授权时作物冒气泡。Codex 同理（信任 hook 后）。
- 退出 App，在 Claude Code 里发一句话，再打开 App，这个事件出现在田里。
- 卸载后，`settings.json` / `hooks.json` 与安装前逐字节一致（除非安装前文件不存在）。
- hook 程序输出为空、退出码为 0 的测试通过。

**M4 菜单栏体验**
- 菜单栏数字、菜单里的任务列表、系统通知都与田里的状态一致。
- 窗口隐藏 1 分钟内，活动监视器里 App 的 CPU 占用接近 0（游戏在页面隐藏时不会绘制；如有必要，窗口隐藏时通知前端暂停）。

**M5 打包与文档**
- `npm run build` 产出 `Agent Farm.app` 和 `.dmg`（未签名即可）。
- 写 `desktop/README.md`：安装（含首次右键 → 打开）、连接 Claude Code / Codex、数据目录、卸载（移除 hook + 删除数据目录）、常见问题（端口被占用、Codex 未信任 hook、通知没出现）。
- 在仓库根 `README.md` 里加一段，指向 `desktop/README.md`。

## 交付时告诉我

- 每个里程碑的验收结果（跑了哪些命令、输出摘要）。
- 与 `server/` 行为不一致的地方（如果有），以及原因。
- 需要我手动做的事（例如安装 Rust 工具链、在 Codex 里信任 hook、系统设置里允许通知）。
