# Agent Farm

把交给 AI 的任务，种成一片田。

Agent Farm 用像素农场展示 AI 任务状态：工作中的任务会长成作物，需要你回复或授权时会冒出提示，出错或失联会显示相应状态，完成后进入出货箱。果园还可以用来拆解和追踪长期目标。

## 体验农场

直接用浏览器打开仓库根目录的 [`index.html`](index.html)，即可体验演示模式。无需安装依赖或构建；演示事件和游戏进度保存在浏览器的 `localStorage` 中，不会改变真实任务状态。

线上站点：[agentfarm.lloydev.site](https://agentfarm.lloydev.site)。在 [账号页面](https://agentfarm.lloydev.site/login.html) 注册或登录，再按 [服务器指南](server/README.md) 连接 Claude Code 或 Codex。线上目标保存在账号中；演示模式的数据保存在当前浏览器。

## 农场玩法

- **任务农场**：查看 AI 任务状态、处理待办、收获已完成任务；农场会随天气、昼夜和季节变化。
- **生活与装饰**：探索住宅、卧室、池塘和鸡舍；布置家具、领养宠物、购买装饰。
- **矿洞冒险**：挖掘矿石、探索宝藏室、收集物品；可切换和平模式。
- **目标果园**：把长期目标拆成里程碑，跟踪成长进度并收获完成的目标。
- **旅行**：前往伦敦、纽约和塞勒姆，体验不同房间、窗景与原创音乐。

按 **H** 查看操作说明，**M** 切换音乐和音效，**Y** 预览季节；其他按键会根据所在场景显示在游戏内说明中。

## 项目状态

- **网页版**：根目录 `index.html` 是农场游戏；`server/` 包含 Cloudflare Worker、D1 数据库迁移、登录和 AI 工具接入页面。部署与接口说明见 [`server/README.md`](server/README.md)。
- **macOS 本地版**：`desktop/src-tauri/` 已有 M1 本地服务与农场状态机，可独立运行和验证；Tauri 窗口、hook 安装界面、菜单栏与应用打包仍按 [`mac-app 实施说明`](docs/codex/mac-app.md) 后续里程碑推进。

## 仓库结构

```text
index.html              像素农场游戏与演示模式
server/                 网页后端、登录、接入指南和数据库迁移
desktop/src-tauri/      macOS 本地服务与农场状态机
desktop/scripts/        本地服务 smoke 脚本
docs/codex/mac-app.md   macOS 应用目标架构和里程碑
```

## 素材与字体

画面、音乐和音效由代码生成。页面使用 [Fusion Pixel 12px Proportional SC](https://github.com/TakWolf/fusion-pixel-font)，版权归 TakWolf 所有，按 [SIL Open Font License 1.1](https://openfontlicense.org) 授权。
