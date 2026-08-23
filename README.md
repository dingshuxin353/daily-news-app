# DailyNews

让你自己的 AI Agent 搜集和整理内容，再把结果编排成一份可阅读、可分享、可定制主题的数字日报。

![DailyNews 默认报纸主题](./docs/assets/dailynews-v0.9.0-newspaper.png)

当前版本是 `v0.12.0`。它在多日报与个人主页之外，新增一份默认关闭、只在本机展示、通过 Agent 对话维护的个人待办。

## 主要能力

- 一条内容对应一个模块，按 `lead`、`important`、`normal` 编译为大、中、小三档版面。
- 桌面端使用四格拼装布局，移动端保持原阅读顺序转换为单列。
- 支持一条内容关联多个来源，并通过共享来源面板查看。
- 内置 `newspaper-default`、`swiss-editorial`、`midnight-tech` 三个可切换主题。
- AI Agent 可以通过受约束的 JSON Candidate 写内容或定制主题，不直接生成 HTML、CSS 和版面坐标。
- 多份 Publication 使用独立配置、内容、提交状态和主题选择，并通过 `/p/<publication-id>/` 读取和切换。
- 可选 Home 从各 Publication 最新正式 Compiled Edition 生成只读总览，并保持内容池隔离。
- Publication 可以继承 Home 固定主题，也可以保持独立固定 revision。
- Schema `2` 内容可以携带一张严格图片；图片不改变优先级、顺序、跨度或行结构。
- 可选个人待办提供只读 `/todo/` 页面和 Home 摘要；正式状态与公开 `dist/` 严格隔离。
- 可以构建为纯静态文件并部署到普通静态站点。

当前本地版本不包含账号、远程 MCP、图片上传或抓取、服务端 Agent 调度、提醒通知和网页内待办编辑。

## 交给 Agent 配置和启动

如果你的 AI Agent 可以读取本地文件并运行终端，把仓库目录交给它后直接复制这段话：

```text
请先阅读仓库根目录的 AGENTS.md。
帮我把这个 DailyNews 配置好并启动。我不懂代码，请先检查现状，
按推荐方案用简单问题和我确认；完成后验证页面，并把可以点击的首页和日报链接发给我。
```

Agent 会从唯一的 [`AGENT_USER_GUIDE.md`](./AGENT_USER_GUIDE.md) 入口判断需要读取的配置、内容或主题说明。你不需要先找 Publication ID、修改 JSON 或运行命令。

## 快速开始

如果没有可以操作本地文件和终端的 Agent，再使用下面的手工方式。

需要：

- Git
- Node.js 22 或更高版本

项目没有第三方运行时依赖，克隆后可以直接启动：

```bash
git clone https://github.com/dingshuxin353/daily-news-app.git
cd daily-news-app
npm start
```

保持命令运行，然后在同一台电脑打开 <http://127.0.0.1:4173>。如需修改本地端口：

```bash
PORT=5173 npm start
```

启动前会校验 Publication Registry、各日报配置、当前主题、Todo 配置和正式数据，并生成仅供本机使用的 `local-dist/`。宿主随后扫描并监听日报与 Todo Candidate：日报只自动发布当前上海日期的安全 `update`，Todo 按唯一正式 State 的 revision 受控处理。
新克隆默认不附带日报数据，因此第一次打开会显示“暂无日报”；这是正常状态。让 Agent 生成第一份 Candidate 并由宿主处理后即可看到日报。

`127.0.0.1` 是本机地址，不能直接发给朋友访问。公开分享需要先构建，再把完整 `dist/` 部署到静态站点；这是独立的部署任务。

## 第一次配置

默认 Publication 由 [`config/publications.json`](./config/publications.json) 登记。编辑目标 Publication 的 [`publications/daily-news/config/site.json`](./publications/daily-news/config/site.json)，可以修改站点名称、强调色、可选 Logo 和三档内容数量上限：

```json
{
  "name": "我的 AI 日报",
  "accentColor": "#F2B84B",
  "priorityLimits": {
    "lead": 1,
    "important": 2,
    "normal": null
  }
}
```

`null` 表示不限，非负整数表示最大数量。所有配置字段和文件规则见 [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md)。

## 让 Agent 写日报

使用统一 Agent 入口提出内容要求，不需要自己提供技术 ID：

```text
请先阅读仓库根目录的 AGENTS.md。
为我的 AI 日报生成今天的内容，关注我指定的方向，重点新闻有可靠图片时配图。
完成后告诉我候选是否已经正式发布；如果服务可用，请验证日报页面并把链接发给我。
```

Agent 的唯一内容产物是：

```text
publications/<publication-id>/data/candidates/YYYY-MM-DD.json
```

Agent 写完即可用 `candidate_ready` 语义结束。`npm start` 正在运行时，宿主会自动消费今天的安全 `update`；服务未运行时会在下一次启动时扫描。维护者也可以显式调用统一处理入口：

```bash
npm run process-candidate -- --publication <publication-id> --candidate publications/<publication-id>/data/candidates/YYYY-MM-DD.json --mode update
```

默认只允许处理当前上海日期。修订历史日期时追加 `--allow-history`；只有明确需要完整替换时才同时使用 `--mode replace --allow-replace`。

Candidate 字段、来源规则、去重方式和 Agent 完成条件见 [`AGENT_CONTENT_GUIDE.md`](./AGENT_CONTENT_GUIDE.md)。

## 让 Agent 管理个人待办

个人待办默认关闭。先让 Agent 读取配置并确认启用，再直接用自然语言提出任务：

```text
请先阅读仓库根目录的 AGENTS.md。
帮我在首页增加个人待办事项，并记下：2026-08-24 15:00 提交本周周报。
如果宿主已处理，请验证个人待办页面并把本机链接发给我。
```

Todo Agent 的唯一写入产物是：

```text
todo/data/candidates/<candidate-id>.json
```

Agent 只交付 Candidate；正式 State、处理状态和本地页面由宿主维护。网页是只读界面，“删除”会映射为可恢复归档，不提供物理删除或提醒通知。完整操作、歧义和完成边界见 [`AGENT_TODO_GUIDE.md`](./AGENT_TODO_GUIDE.md)。

## 切换或定制主题

查看当前主题和已经保存的主题：

```bash
npm run list-themes -- --publication <publication-id>
```

切换已有主题：

```bash
npm run switch-theme -- --publication <publication-id> --theme swiss-editorial --confirm swiss-editorial
```

恢复跟随 Home 或直接切换 Home：

```bash
npm run inherit-theme -- --publication <publication-id> --confirm
npm run switch-theme -- --home --theme swiss-editorial --revision 1 --confirm swiss-editorial
```

让 Agent 新增、修改或切换主题时，也从统一入口表达希望看到的结果：

```text
请先阅读仓库根目录的 AGENTS.md。
把产品日报改成独立的深色科技风格，其他日报继续跟随首页。
请先检查现有主题；需要正式切换前用简单摘要和我确认。
```

Agent 写完 Candidate 后即可结束。支持本地命令的宿主或维护者可以继续处理：

```bash
npm run process-theme -- --candidate themes/candidates/<theme-id>.json
```

运行 `npm start` 后，通过 `/p/<publication-id>/?themePreview=<theme-id>` 查看目标日报预览。用户确认后再激活：

```bash
npm run activate-theme -- --publication <publication-id> --theme <theme-id> --confirm <theme-id>
```

主题字段、允许值和 Agent 边界见 [`AGENT_THEME_GUIDE.md`](./AGENT_THEME_GUIDE.md)。

## 数据与目录

| 路径 | 作用 | 维护者 |
| --- | --- | --- |
| `config/publications.json` | Publication 顺序和默认项 | 用户或宿主 |
| `config/home.json` | Home 开关、名称、强调色和固定主题 | 用户或宿主 |
| `config/todo.json` | 本地个人待办开关 | 用户或宿主 |
| `publications/<id>/config/site.json` | 站点设置和内容数量上限 | 用户 |
| `publications/<id>/config/theme.json` | 当前主题选择 | 主题命令 |
| `publications/<id>/data/candidates/` | 日报 Candidate | Agent |
| `publications/<id>/data/issues/` | 正式日报事实 | Issue Writer |
| `publications/<id>/data/compiled/` | 前端渲染数据 | Layout Compiler |
| `publications/<id>/data/submissions/` | Candidate 处理状态 | 本地宿主 |
| `themes/candidates/` | 主题 Candidate | Agent |
| `themes/definitions/` | 持久主题库 | Theme Writer |
| `themes/compiled/` | 编译后的主题 CSS | Theme Compiler |
| `publications/<id>/themes/active.json` | 当前主题运行时清单 | 主题命令 |
| `todo/data/candidates/` | Todo Candidate | Agent |
| `todo/data/state.json` | 唯一正式 Todo State | Todo Writer |
| `todo/data/submissions/` | Todo Candidate 处理状态 | 本地宿主 |

不要手工修改生成目录来绕过 Writer、Compiler 或主题命令。

## 从 v0.9 迁移

在仍使用根级 `config/site.json`、`data/` 和 `themes/active.json` 的 v0.9 安装中，先备份并明确选择默认 Publication ID，再运行：

```bash
npm run migrate-v0.9 -- --publication <publication-id> --confirm <publication-id>
```

迁移只复制并校验数据，最后才激活 Publication Registry；不会删除或覆盖原始 v0.9 文件。目标已存在时拒绝合并，重复执行同一份已成功迁移的结果只返回 `unchanged`。不要在已经使用多 Publication 的仓库中运行此命令。

从 v0.10 升级 Home 与主题选择时，先只生成报告，再明确应用，并显式选择 Home 开关：

```bash
npm run migrate-v0.10 -- --home-enabled false
npm run migrate-v0.10 -- --home-enabled false --apply --confirm migrate-v0.11.0
```

该命令不能未经用户单独授权用于真实数据。

## 构建与部署

```bash
npm test
npm run build
```

构建成功后，公开静态站点位于 `dist/`。即使 Todo 已启用，普通构建也不会把 Todo 页面、导航、任务数量或私人数据写入 `dist/`。把该目录中的全部文件部署到任意能够按原路径提供 HTML、JavaScript、CSS 和 JSON 的静态站点即可。

`npm start` 只绑定本机并使用包含 Todo 的私有 `local-dist/`；不要部署或分享这个目录。静态构建成功也不等于已经公开部署。只有部署后的公开地址经过真实访问验证，才能作为可分享链接交付。

## 文档入口

| 文档 | 读者 | 用途 |
| --- | --- | --- |
| [`AGENTS.md`](./AGENTS.md) | AI Agent | 判断用户支持或源码开发任务 |
| [`AGENT_USER_GUIDE.md`](./AGENT_USER_GUIDE.md) | 用户服务 Agent | 理解自然语言意图、编排配置与启动、路由专项说明和处理常见问题 |
| [`AGENT_CONTENT_GUIDE.md`](./AGENT_CONTENT_GUIDE.md) | 内容 Agent | 生成日报 Candidate |
| [`AGENT_TODO_GUIDE.md`](./AGENT_TODO_GUIDE.md) | Todo Agent | 生成 Todo Candidate、处理歧义并区分候选与正式状态 |
| [`AGENT_THEME_GUIDE.md`](./AGENT_THEME_GUIDE.md) | 主题 Agent | 查看、切换或生成主题 Candidate |
| [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) | 用户与维护者 | 配置站点、主题和运行方式 |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 贡献者与开发 Agent | 分支、提交、审查、验证和目录规则 |

## 开发验证

```bash
npm test
npm run build
node --check src/app.js
git diff --check
```

`v0.12.0` 保持 Content Schema `2` 与 Theme Schema `1`，新增独立 Todo Schema `1`。发布前仍需通过全量测试、公开隐私构建、文档链接检查和本地浏览器验收。

## 开源许可

本项目使用 [MIT License](./LICENSE)。
