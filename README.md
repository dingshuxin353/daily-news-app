# DailyNews

让你自己的 AI Agent 搜集和整理内容，再把结果编排成一份可阅读、可分享、可定制主题的数字日报。

![DailyNews 默认报纸主题](./docs/assets/dailynews-v0.9.0-newspaper.png)

当前版本是 `v0.12.1`。它提供多份相互隔离的日报、可选个人主页、受约束主题、单条新闻图片，以及默认关闭、只在本机展示的个人待办。本次 PATCH 只改进 Agent 安全说明和上手路径，不改变运行逻辑、页面、Schema、配置或数据。

## 主要能力

- AI Agent 通过受约束的 Candidate 写日报、个人待办或定制主题，不直接生成页面和正式数据。
- 多份 Publication 拥有独立配置、内容、提交状态和主题选择，通过 Home 统一导航与汇总。
- 日报按 `lead`、`important`、`normal` 编排为大、中、小模块，支持多个来源和每条最多一张严格图片。
- 内置 `newspaper-default`、`swiss-editorial`、`midnight-tech` 三个主题，Publication 可以跟随 Home 或独立覆盖。
- 可选个人待办提供只读 `/todo/` 页面和 Home 摘要，并与公开 `dist/` 严格隔离。
- 日报可以构建为纯静态文件并部署到普通静态站点；私人 Todo 只在本机运行中出现。

当前版本不包含账号、远程 MCP、图片上传或抓取、提醒通知、网页内待办编辑和服务端 Agent 调度。

## 选择你的使用方式

| 你希望怎么使用 | 从哪里开始 |
| --- | --- |
| 我不懂代码，希望 Agent 帮我配置、启动和维护 | [小白用户：交给 Agent](#小白用户交给-agent) |
| 我会使用终端，希望手工运行和配置 | [进阶用户：手工运行和配置](#进阶用户手工运行和配置) |
| 我要修改程序功能、页面结构或公共样式 | [开发者：修改源码](#开发者修改源码) |

## 小白用户：交给 Agent

你只需要：

1. 下载或克隆本仓库，并用能够访问项目文件的 AI Agent 打开它。
2. 复制下面的首次使用请求。
3. 用普通语言回答 Agent 的少量问题，不需要理解命令、JSON、Publication ID 或 theme revision。
4. 等待 Agent 检查、配置、启动和真实访问验证。
5. 接收可点击的 Home、默认日报，以及启用时的个人待办链接。

### 首次配置和启动

```text
请先阅读仓库根目录的 AGENTS.md，按照用户指南帮我完成 DailyNews 的首次配置和启动。
我不懂代码，请用简单问题逐步和我确认，默认不要修改源码。
完成后请验证页面，并把可以点击的首页、日报和待办链接发给我。
```

### 生成日报

```text
请先阅读仓库根目录的 AGENTS.md。
帮我生成第一份日报，关注我指定的方向，重点新闻有可靠图片时配图。
完成后请告诉我候选是否已经正式发布；如果服务可用，请验证页面并把链接发给我。
```

### 管理个人待办

```text
请先阅读仓库根目录的 AGENTS.md。
帮我启用只在本机显示的个人待办，并添加我接下来告诉你的三项任务。
如果宿主已处理，请验证待办页面并把本机链接发给我。
```

### 参考图片调整主题

```text
请参考我提供的图片帮我调整主题。
优先使用现有主题或 Theme Candidate，不要修改源码，先给我预览。
如果你判断必须修改源码，请先用简单的话说明会影响哪些功能和以后更新，
并等待我明确确认。
```

参考图片默认只代表视觉意图，不授权 Agent 修改页面源码。当前主题能力无法完全复刻时，Agent 应先给出不改源码的接近版本，并建议把超出能力的效果作为功能需求提交给项目开发者评估。

## 进阶用户：手工运行和配置

### 安装与启动

需要 Git 和 Node.js 22 或更高版本：

```bash
git clone https://github.com/dingshuxin353/daily-news-app.git
cd daily-news-app
npm install
npm start
```

保持命令运行，然后在同一台电脑打开 <http://127.0.0.1:4173>。如需修改本地端口：

```bash
PORT=5173 npm start
```

启动前会校验 Publication Registry、Home、Todo、各日报配置、正式内容和主题，并生成只供本机使用的 `local-dist/`。宿主随后扫描并监听日报与 Todo Candidate。新克隆默认没有日报内容，首次打开显示“暂无日报”是正常状态。

`127.0.0.1` 只供本机访问。公开分享与本地启动是不同任务，不能把包含私人 Todo 的 `local-dist/` 部署到公网。

### 配置文件职责

| 文件 | 可以配置什么 |
| --- | --- |
| `config/publications.json` | Publication 顺序和默认日报 |
| `config/home.json` | Home 开关、名称、强调色和固定主题 |
| `config/todo.json` | 本地个人待办开关 |
| `publications/<id>/config/site.json` | 该日报的名称、强调色、Logo 和内容数量上限 |
| `publications/<id>/config/theme.json` | 该日报跟随 Home 或使用独立主题；应通过受控主题流程维护 |

推荐手工顺序：

1. 确认 Node.js 和本地端口。
2. 检查 Publication Registry。
3. 设置 Home 与 Todo 开关。
4. 配置每份 Publication 的站点信息。
5. 选择 Home 与 Publication 主题。
6. 准备日报或 Todo Candidate。
7. 启动并真实访问 Home、默认 Publication 和启用时的 `/todo/`。

完整字段、命令和约束见 [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md)。日报 Candidate 见 [`AGENT_CONTENT_GUIDE.md`](./AGENT_CONTENT_GUIDE.md)，Todo Candidate 见 [`AGENT_TODO_GUIDE.md`](./AGENT_TODO_GUIDE.md)，主题选择与 Candidate 见 [`AGENT_THEME_GUIDE.md`](./AGENT_THEME_GUIDE.md)。

Candidate 是 Agent 的提案，不是正式结果。不要把正式 Issue、Todo State、Submission Status、Active Theme、编译数据或页面产物当作普通配置手工修改，也不要绕过 Validator、Writer、Compiler 或受控主题命令。

## 开发者：修改源码

普通配置和主题调整不需要修改源码。修改程序功能、页面结构、公共样式或构建逻辑前，先阅读根级 [`AGENTS.md`](./AGENTS.md)；获得用户明确的源码修改确认后，再按 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 建立任务分支、实施最小改动并验证。

主题预览或激活确认不等于源码修改确认，源码修改确认也不等于推送、合并、Tag、Release、部署或数据迁移授权。

## 数据与目录

| 路径 | 作用 | 维护者 |
| --- | --- | --- |
| `publications/<id>/data/candidates/` | 日报 Candidate | Agent |
| `publications/<id>/data/issues/` | 正式日报事实 | Issue Writer |
| `publications/<id>/data/compiled/` | 前端渲染数据 | Layout Compiler |
| `publications/<id>/data/submissions/` | 日报 Candidate 处理状态 | 本地宿主 |
| `themes/candidates/` | 主题 Candidate | Agent |
| `themes/definitions/` | 持久主题库 | Theme Writer |
| `themes/compiled/` | 编译后的主题 CSS | Theme Compiler |
| `publications/<id>/themes/active.json` | 当前主题运行时清单 | 受控主题流程 |
| `todo/data/candidates/` | Todo Candidate | Agent |
| `todo/data/state.json` | 唯一正式 Todo State | Todo Writer |
| `todo/data/submissions/` | Todo Candidate 处理状态 | 本地宿主 |

不要手工修改正式数据或生成目录来绕过处理流程。

## 数据迁移

在仍使用根级 `config/site.json`、`data/` 和 `themes/active.json` 的 v0.9 安装中，先备份并明确选择默认 Publication ID，再运行：

```bash
npm run migrate-v0.9 -- --publication <publication-id> --confirm <publication-id>
```

从 v0.10 升级 Home 与主题选择时，先只生成报告，再明确应用，并显式选择 Home 开关：

```bash
npm run migrate-v0.10 -- --home-enabled false
npm run migrate-v0.10 -- --home-enabled false --apply --confirm migrate-v0.11.0
```

迁移会触及正式数据，不能未经用户单独授权在真实安装上执行。

## 构建与部署

```bash
npm test
npm run build
```

公开静态站点生成在 `dist/`。即使 Todo 已启用，普通构建也不会把 Todo 页面、导航、数量或私人数据写入该目录。部署时上传完整 `dist/`，并在公开地址真实验证后再交付链接。

`npm start` 使用的 `local-dist/` 可能包含私人 Todo，不能部署或分享。静态构建成功也不代表已经公开发布。

## 文档入口

| 文档 | 读者 | 用途 |
| --- | --- | --- |
| [`AGENTS.md`](./AGENTS.md) | AI Agent | 判断用户支持或源码开发任务，并遵守源码授权边界 |
| [`AGENT_USER_GUIDE.md`](./AGENT_USER_GUIDE.md) | 用户服务 Agent | 理解自然语言意图、编排配置与启动、路由专项说明 |
| [`AGENT_CONTENT_GUIDE.md`](./AGENT_CONTENT_GUIDE.md) | 内容 Agent | 生成日报 Candidate |
| [`AGENT_TODO_GUIDE.md`](./AGENT_TODO_GUIDE.md) | Todo Agent | 生成 Todo Candidate、处理歧义并区分候选与正式状态 |
| [`AGENT_THEME_GUIDE.md`](./AGENT_THEME_GUIDE.md) | 主题 Agent | 处理参考图、查看与切换主题、生成 Theme Candidate |
| [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) | 进阶用户与维护者 | 配置站点、主题和运行方式 |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 贡献者与开发 Agent | 分支、提交、审查、验证和目录规则 |

## 开发验证

```bash
npm test
npm run build
node --check src/app.js
git diff --check
```

`v0.12.1` 保持 Content Schema `2`、Theme Schema `1` 和 Todo Schema `1`，不改变页面与运行行为。

## 开源许可

本项目使用 [MIT License](./LICENSE)。
