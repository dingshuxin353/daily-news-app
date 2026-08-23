# DailyNews 配置说明

适用产品版本：`0.11.0`

更新日期：2026-08-23

DailyNews 使用全局 Publication Registry，并把每份日报的站点配置、内容数据和主题选择保存在自己的目录中。正式日报、编译数据和 Active Theme 由代码维护，不应通过手工编辑生成文件来配置。

## Home Profile

文件：[`config/home.json`](../config/home.json)

`enabled` 决定根路径展示个人总览还是进入默认 Publication；`name` 和 `accentColor` 只属于主页；`activeTheme` 固定主页主题 ID 与 revision。主页只读取各 Publication 最新正式 Compiled Edition，不拥有 Candidate、Issue 或独立内容池。

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

`npm start` 会在启动服务前运行数据准备和静态构建，然后扫描并监听各 Publication 的 Candidate。只有当前上海日期的安全 `update` 会自动进入 Writer 与 Compiler；历史日期记录为 `authorization_required`，校验失败记录为 `rejected`。`npm run build` 会重新生成 `dist/`。这些过程可能更新编译数据、索引和 Submission Status。

## 7. 静态构建

```bash
npm run build
```

构建输出位于 `dist/`，其中包含页面、站点配置、正式日报、编译主题和公开资源。部署时必须保持目录结构，不要只上传 `index.html`。

Home 开启时根路径是个人总览，关闭时进入 Registry 中的默认 Publication；正式入口是 `/p/<publication-id>/`，日期使用 `?date=YYYY-MM-DD`。未知 Publication 返回 404，不存在日期不会回退到其他日报。

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

当前本地版本不需要 API Token、数据库密码或云端密钥。不要把任何内容源凭证、Cookie、Agent Token 或私人配置写入 Candidate、主题文件或源码仓库。
