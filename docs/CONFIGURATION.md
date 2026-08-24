# DailyNews 配置说明

适用产品版本：`0.12.1`

更新日期：2026-08-24

DailyNews 使用全局 Publication Registry，并把每份日报的站点配置、内容数据和主题选择保存在自己的目录中。正式日报、编译数据和 Active Theme 由代码维护，不应通过手工编辑生成文件来配置。

面向用户的配置任务由 [`AGENT_USER_GUIDE.md`](../AGENT_USER_GUIDE.md) 统一路由。进入本页后，在用户确认结果的前提下，Agent 可以修改本页列出的配置文件；不能把正式 Issue、Compiled、索引、Submission Status 或 Active Manifest 当作普通配置手工覆盖。

## Home Profile

文件：[`config/home.json`](../config/home.json)

`enabled` 决定根路径展示个人总览还是进入默认 Publication；`name` 和 `accentColor` 只属于主页；`activeTheme` 固定主页主题 ID 与 revision。主页只读取各 Publication 最新正式 Compiled Edition，不拥有 Candidate、Issue 或独立内容池。

## Personal Todo

文件：[`config/todo.json`](../config/todo.json)

```json
{
  "schemaVersion": 1,
  "enabled": false
}
```

Todo 默认关闭且安装级唯一，只在绑定 `127.0.0.1` 的本地运行中展示。启用后，本地 `/todo/` 提供只读五分组页面，Home 与 Todo 同时启用时首页显示最多五条摘要；Home 关闭不影响 `/todo/` 和正式 State。关闭 Todo 只停止展示与自动处理，不删除已有数据。

Todo Agent 按 [`AGENT_TODO_GUIDE.md`](../AGENT_TODO_GUIDE.md) 写 `todo/data/candidates/<candidate-id>.json`。`todo/data/state.json`、`todo/data/submissions/` 和锁均由 Writer 或宿主维护，不能手工修改。Todo 不属于 Publication，也不创建独立主题，固定使用 Home Effective Theme。

## 1. Publication Registry

文件：[`config/publications.json`](../config/publications.json)

```json
{
  "schemaVersion": 1,
  "defaultPublicationId": "daily-news",
  "publicationIds": ["daily-news"]
}
```

`publicationIds` 必须是非空、不重复的有序数组；ID 只使用小写字母、数字和连字符。`defaultPublicationId` 必须属于该数组。默认项只影响阅读入口，不能替模糊的内容或主题写入任务选择目标。

### 新增或调整 Publication 的一致性

当前没有专用的 Publication 创建命令。Agent 只有在用户明确确认后，才能在现有文件架构内新增或调整，并同时保证：

- 稳定 ID 与 `publications/<id>/` 目录名完全一致，Registry 顺序和默认项明确。
- 每份 Publication 都有自己的 `config/site.json`、`config/theme.json`、`data/` 子目录、`data/index.json` 和 `themes/active.json`。
- 新 Publication 的主题选择使用 Schema `2` 的 `inherit`；Active Manifest 必须与当前 Home Effective Theme 一致。
- Candidate、Issue、Compiled 和 Submission 目录彼此独立；不能复制另一份日报的正式内容冒充新日报。
- 目标目录和所需文件全部准备完成后再登记到 Registry；不能留下半配置状态。

如果 Agent 无法从当前合法安装安全形成完整结构，应停止并说明“当前没有创建命令”，不能猜测缺失文件、Schema 或正式主题产物。调整已有 Publication 时只修改用户要求的配置，不重建或覆盖其内容目录。

## 2. 站点配置

文件：`publications/<publication-id>/config/site.json`

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

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `name` | 是 | 非空站点名称，显示在报头和页面标题中 |
| `accentColor` | 是 | 六位十六进制颜色，如 `#F2B84B` |
| `logo` | 否 | `public/` 下以 `/` 开头的本地路径，或 `https://` 地址 |
| `priorityLimits.lead` | 是 | `lead` 最大数量；非负整数或 `null` |
| `priorityLimits.important` | 是 | `important` 最大数量；非负整数或 `null` |
| `priorityLimits.normal` | 是 | `normal` 最大数量；非负整数或 `null` |

数量配置都是上限，不是最低数量：

- `0` 表示禁用该级别。
- `null` 表示不限制数量。
- 超出上限的内容由 Layout Compiler 按 `lead → important → normal` 确定性降级。
- 如果三个有限上限都已用满，编译会失败，不会静默删除内容。

### 本地 Logo

把文件放到 `public/`，配置值使用站点根路径：

```json
{
  "logo": "/logo.svg"
}
```

对应文件必须真实存在于 `public/logo.svg`，且路径不能指向 `public/` 之外。为了让静态部署保持自包含，优先使用本地资源。

## 3. 当前主题

文件：`publications/<publication-id>/config/theme.json`

```json
{
  "schemaVersion": 2,
  "mode": "inherit"
}
```

`inherit` 跟随 Home 当前固定主题；独立覆盖使用：

```json
{
  "schemaVersion": 2,
  "mode": "override",
  "activeTheme": {
    "id": "newspaper-default",
    "revision": 1
  }
}
```

不要手工修改这个文件。为 Publication 切换主题会显式转为 `override`：

```bash
npm run list-themes -- --publication <publication-id>
npm run switch-theme -- --publication <publication-id> --theme <theme-id> --confirm <theme-id>
```

显式恢复继承：

```bash
npm run inherit-theme -- --publication <publication-id> --confirm
```

切换 Home 主题：

```bash
npm run switch-theme -- --home --theme <theme-id> --revision <revision> --confirm <theme-id>
```

指定历史 revision：

```bash
npm run switch-theme -- --publication <publication-id> --theme <theme-id> --revision <revision> --confirm <theme-id>
```

当前内置主题：

- `newspaper-default`
- `swiss-editorial`
- `midnight-tech`

新增或修改主题时，让 Agent 按 [`AGENT_THEME_GUIDE.md`](../AGENT_THEME_GUIDE.md) 生成 `themes/candidates/<theme-id>.json`。Candidate 不能直接成为正式主题。

## 4. 日报内容

内容 Agent 按 [`AGENT_CONTENT_GUIDE.md`](../AGENT_CONTENT_GUIDE.md) 写入：

```text
publications/<publication-id>/data/candidates/YYYY-MM-DD.json
```

候选完成后，运行中的 `npm start` 宿主会自动消费当前上海日期的安全 `update`；服务未运行时在下一次启动扫描。维护者也可以显式调用：

```bash
npm run process-candidate -- --publication <publication-id> --candidate publications/<publication-id>/data/candidates/YYYY-MM-DD.json --mode update
```

历史日期需要 `--allow-history`；`replace` 需要同时使用 `--mode replace --allow-replace`。这些授权只能来自用户或受信任宿主，不能写入 Candidate。

新 Candidate 使用 Schema `2`，每条内容可以省略或携带一张严格 `image`。外部图片只接受 HTTPS 引用；本地图片必须放在 `public/` 内并真实存在。Schema `1` 历史内容继续以纯文字读取，不能更新已经升级为 Schema `2` 的 Issue。

各目录职责：

| 路径 | 是否手工维护 | 说明 |
| --- | --- | --- |
| `publications/<id>/data/candidates/` | Agent 可以 | 一轮完整内容提案 |
| `publications/<id>/data/issues/` | 否 | Issue Writer 维护的正式内容事实 |
| `publications/<id>/data/compiled/` | 否 | Layout Compiler 生成的前端数据 |
| `publications/<id>/data/index.json` | 否 | 数据准备过程生成的日期索引 |
| `publications/<id>/data/submissions/` | 否 | 宿主维护的处理状态 |

## 5. 主题文件

| 路径 | 是否手工维护 | 说明 |
| --- | --- | --- |
| `themes/candidates/` | Agent 可以 | 新增或修改主题的声明式候选 |
| `themes/presets/` | 仅源码维护者 | 官方主题继承起点 |
| `themes/definitions/` | 否 | Theme Writer 保存的不可变 revisions |
| `themes/compiled/` | 否 | Theme Compiler 生成的 CSS |
| `themes/previews/` | 否 | Candidate 的预览产物 |
| `publications/<id>/themes/active.json` | 否 | 该 Publication 当前主题运行时清单 |

## 6. 本地运行配置

默认启动地址是 `http://127.0.0.1:4173`。仅端口可以通过环境变量覆盖：

```bash
PORT=5173 npm start
```

`npm start` 会在启动服务前运行数据准备和本地构建，然后扫描并监听各 Publication 与 Todo Candidate。只有当前上海日期的安全日报 `update` 会自动进入 Writer 与 Compiler；Todo 使用唯一正式 State 的 revision 和安装级锁处理。历史日报日期记录为 `authorization_required`，校验失败记录为 `rejected`。本地页面写入 `local-dist/`，其中可能包含私人 Todo 内容，不能部署或分享。

### Agent 配置与验证顺序

1. 确认当前目录、Git 状态、Node.js 和 npm，并读取现有 Home、Todo、Registry、站点和主题配置。
2. 用人类可理解的结果摘要取得确认；保留用户已有设置和无关工作区改动。
3. 只修改与确认结果直接相关的配置，不手工写生成产物。
4. 不需要保持服务时运行 `npm run build`，确认配置、数据和主题校验通过。
5. 需要交付链接时，先检查是否已有可用实例，再用 `npm start` 或实际选定端口启动。
6. 等待启动成功，并通过真实 HTTP 请求检查根路径、每个目标 `/p/<publication-id>/` 和启用时的 `/todo/`；最终只返回本次实际验证过的端口与链接。

构建通过只证明静态产物可生成，不代表服务仍在运行。配置文件已修改也不等于页面已发布或公开部署。

## 7. 静态构建

```bash
npm run build
```

构建输出位于 `dist/`，其中只包含公开页面、站点配置、正式日报、编译主题和公开资源。即使 `config/todo.json.enabled` 为 `true`，普通构建也不生成 Todo 页面、导航、模块或任何任务数据。部署时必须保持目录结构，不要只上传 `index.html`。

Home 开启时根路径是个人总览，关闭时进入 Registry 中的默认 Publication；正式入口是 `/p/<publication-id>/`，日期使用 `?date=YYYY-MM-DD`。未知 Publication 返回 404，不存在日期不会回退到其他日报。

Todo 只存在于 `npm start` 使用的私有 `local-dist/`，不是公开静态构建的一部分。不要把 `local-dist/` 当成部署产物。

## 8. v0.9 数据迁移

仅在尚未建立 Publication Registry 的 v0.9 单日报安装中运行：

```bash
npm run migrate-v0.9 -- --publication <publication-id> --confirm <publication-id>
```

命令复制并校验根级站点配置、Candidate、Issue、Compiled、索引和 Active Theme，校验成功后才创建 Registry。原始 `config/`、`data/` 和 `themes/active.json` 保持不变；目标目录已存在时不会合并或覆盖。

## 9. 配置安全

从合法 v0.10 多 Publication 安装升级时，必须先只生成迁移报告，再明确确认应用；同时显式选择 Home 是否启用：

```bash
npm run migrate-v0.10 -- --home-enabled false
npm run migrate-v0.10 -- --home-enabled false --apply --confirm migrate-v0.11.0
```

默认 Publication 迁移为 `inherit`，其他 Publications 保留原主题并迁移为 `override`。不要在真实安装上运行迁移，除非用户另行明确授权并已备份。

当前本地版本不需要 API Token、数据库密码或云端密钥。不要把任何内容源凭证、Cookie、Agent Token、私人配置或真实 Todo 内容写入文档、测试、日报 Candidate、主题文件、日志或源码仓库。

Agent 还必须遵守：

- 不清理、重置或覆盖无法识别的工作区修改。
- 不因配置任务删除日报、迁移真实数据或修改源码。
- 安装 Node.js、修改系统环境、执行迁移或公开部署前另行取得用户同意。
- 校验失败时只修复相关配置，并用人话说明影响；不能绕过 Validator 或直接改生成文件获得绿灯。
