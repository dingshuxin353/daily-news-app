# DailyNews 配置说明

适用产品版本：`0.9.0`

更新日期：2026-08-21

DailyNews 的用户配置集中在 `config/`，内容与主题候选分别写入各自目录。正式日报、编译数据和正式主题由代码维护，不应通过手工编辑生成文件来配置。

## 1. 站点配置

文件：[`config/site.json`](../config/site.json)

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

## 2. 当前主题

文件：[`config/theme.json`](../config/theme.json)

```json
{
  "schemaVersion": 1,
  "activeTheme": {
    "id": "newspaper-default",
    "revision": 1
  }
}
```

这个文件记录当前主题 ID 和 revision。不要手工修改它；请先查看主题库，再通过受控命令切换：

```bash
npm run list-themes
npm run switch-theme -- --theme <theme-id> --confirm <theme-id>
```

指定历史 revision：

```bash
npm run switch-theme -- --theme <theme-id> --revision <revision> --confirm <theme-id>
```

当前内置主题：

- `newspaper-default`
- `swiss-editorial`
- `midnight-tech`

新增或修改主题时，让 Agent 按 [`AGENT_THEME_GUIDE.md`](../AGENT_THEME_GUIDE.md) 生成 `themes/candidates/<theme-id>.json`。Candidate 不能直接成为正式主题。

## 3. 日报内容

内容 Agent 按 [`AGENT_CONTENT_GUIDE.md`](../AGENT_CONTENT_GUIDE.md) 写入：

```text
data/candidates/YYYY-MM-DD.json
```

候选完成后，由宿主环境决定何时调用：

```bash
npm run process-candidate -- --candidate data/candidates/YYYY-MM-DD.json --mode update
```

各目录职责：

| 路径 | 是否手工维护 | 说明 |
| --- | --- | --- |
| `data/candidates/` | Agent 可以 | 一轮完整内容提案 |
| `data/issues/` | 否 | Issue Writer 维护的正式内容事实 |
| `data/compiled/` | 否 | Layout Compiler 生成的前端数据 |
| `data/index.json` | 否 | 数据准备过程生成的日期索引 |

## 4. 主题文件

| 路径 | 是否手工维护 | 说明 |
| --- | --- | --- |
| `themes/candidates/` | Agent 可以 | 新增或修改主题的声明式候选 |
| `themes/presets/` | 仅源码维护者 | 官方主题继承起点 |
| `themes/definitions/` | 否 | Theme Writer 保存的不可变 revisions |
| `themes/compiled/` | 否 | Theme Compiler 生成的 CSS |
| `themes/previews/` | 否 | Candidate 的预览产物 |
| `themes/active.json` | 否 | 当前主题运行时清单 |

## 5. 本地运行配置

默认启动地址是 `http://127.0.0.1:4173`。仅端口可以通过环境变量覆盖：

```bash
PORT=5173 npm start
```

`npm start` 会在启动服务前运行数据准备；`npm run build` 会重新生成 `dist/`。这两个过程都可能更新编译数据和索引。

## 6. 静态构建

```bash
npm run build
```

构建输出位于 `dist/`，其中包含页面、站点配置、正式日报、编译主题和公开资源。部署时必须保持目录结构，不要只上传 `index.html`。

## 7. 配置安全

当前本地版本不需要 API Token、数据库密码或云端密钥。不要把任何内容源凭证、Cookie、Agent Token 或私人配置写入 Candidate、主题文件或源码仓库。
