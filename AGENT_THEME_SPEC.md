# DailyNews Agent Theme Spec

本文件是外部 Agent 为 DailyNews `v0.7.0` 生成主题候选的唯一入口。当前 Theme Schema 为 `1`。

## 权限边界

Agent 可以读取：

- `themes/presets/*.json`：已安装的官方 Preset
- `themes/active.json`：当前 Active Theme 指针
- `themes/definitions/<theme-id>/<revision>.json`：已激活主题的只读定义
- `themes/candidates/<theme-id>.json`：当前候选（如果存在）

Agent 唯一可写目录是 `themes/candidates/`。不要写入或覆盖 `themes/presets/`、`themes/previews/`、`themes/definitions/`、`themes/compiled/` 和 `themes/active.json`。

主题候选与日报内容候选相互独立。不要在主题候选中写日报内容，也不要根据主题修改 `data/issues/`、`data/compiled/` 或 `data/index.json`。

## Candidate Schema

文件名必须是 `<theme-id>.json`，并与 `id` 完全一致：

```json
{
  "schemaVersion": 1,
  "id": "blue-finance",
  "name": "深蓝财经",
  "description": "克制、紧凑的深蓝财经报纸风格。",
  "extends": "newspaper-default",
  "tokens": {
    "colors": {
      "background": "#F4F1E8",
      "text": "#10233C",
      "muted": "#586979",
      "accent": "#805D18",
      "rule": "#BCC3C9"
    },
    "typography": {
      "headlinePreset": "serif-cn",
      "uiPreset": "sans-cn",
      "headlineScale": "restrained"
    },
    "density": "compact",
    "ruleStyle": "strong",
    "surfaceStyle": "paper",
    "motion": "subtle"
  },
  "recipes": {
    "masthead": "classic",
    "lead": "split",
    "important": "ruled",
    "normal": "minimal"
  }
}
```

- `schemaVersion` 固定为整数 `1`。
- `id` 只使用小写字母、数字和连字符。
- `extends` 必须是 `newspaper-default`、`swiss-editorial`、`midnight-tech` 或源码中其他已安装官方 Preset；不能继承 Candidate。
- `tokens` 和 `recipes` 都必须存在，允许部分覆盖，但合计至少包含一个覆盖字段。
- 所有未知字段都会被拒绝。
- 颜色只接受六位十六进制 `#RRGGBB`，合并后的 `text`、`muted` 与背景对比度必须不低于 `4.5:1`。

合法枚举：

- `headlinePreset`、`uiPreset`：`serif-cn`、`sans-cn`、`mono`
- `headlineScale`：`restrained`、`editorial`、`poster`
- `density`：`compact`、`balanced`、`spacious`
- `ruleStyle`：`hairline`、`strong`、`double`
- `surfaceStyle`：`flat`、`paper`、`soft-gradient`
- `motion`：`none`、`subtle`
- `masthead`：`compact`、`classic`、`banner`
- `lead`：`split`、`stacked`、`editorial`
- `important`：`ruled`、`minimal`、`contrast`
- `normal`：`compact`、`minimal`、`accent`

## 禁止内容

Candidate 不得包含 HTML、CSS、CSS 选择器、JavaScript、`style`、`@import`、`url()`、远程资源、字体地址、DOM、网格坐标、栏数、span、断点、隐藏内容规则、负间距、绝对定位、`z-index`、revision、激活或回滚指令。

## 处理与预览

写完 Candidate 后运行：

```bash
npm run process-theme -- --candidate themes/candidates/<theme-id>.json
```

命令返回 JSON：

- `preview-ready`：校验通过并生成新预览。
- `unchanged`：候选及有效编译输入没有变化，现有预览仍然有效。
- `rejected`：候选不合法；读取 `field` 和 `reason` 修正后重试。

预览当前真实日报：

```text
http://127.0.0.1:4173/?themePreview=<theme-id>
```

预览固定压力测试日报：

```text
http://127.0.0.1:4173/?themePreview=<theme-id>&themeStress=1
```

自动检查通过仅表示主题可用，不代表用户已认可审美。

## 激活边界

未获得用户针对当前 Candidate 的明确授权时，禁止调用 `activate-theme`。获得明确授权后，激活命令仍要求主题 ID 二次确认：

```bash
npm run activate-theme -- --theme <theme-id> --confirm <theme-id>
```

激活失败时不得绕过 Theme Writer 覆盖 Definition、Compiled Theme 或 Active Pointer。回滚同样只由产品命令处理：

```bash
npm run rollback-theme -- --confirm
```
