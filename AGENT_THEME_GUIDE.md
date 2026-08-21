# DailyNews AI Agent 主题使用指南

指南版本：1.0
适用产品版本：0.8.0
Theme Schema：1
更新日期：2026-08-21

这份指南告诉外部 AI Agent 如何查看、切换、新增和修改 DailyNews 主题。主题字段的最终机器约束由 Theme Validator 和 Theme Compiler 执行；本指南负责说明任务选择、操作顺序、用户确认和完成条件。

如果任务是生成或更新日报内容，请改读 [`AGENT_CONTENT_GUIDE.md`](./AGENT_CONTENT_GUIDE.md)。主题操作不能修改日报内容和布局。

## 1. 先判断任务类型

| 用户意图 | 正确操作 | 是否创建 Theme Revision |
| --- | --- | --- |
| 查看有哪些主题 | `npm run list-themes` | 否 |
| 切换到已有主题 | `npm run switch-theme` | 否 |
| 新增一个主题 | 新 ID Candidate → 预览 → 确认激活 | 是，从 1 开始 |
| 修改已有主题 | 原 ID Candidate → 预览 → 确认激活 | 是，增加 revision |
| 回到上一次选择 | `npm run rollback-theme` | 否 |

切换不是覆盖：所有正式主题都保存在 `themes/definitions/<theme-id>/<revision>.json`，旧主题和旧 revision 不会因为切换而删除。

## 2. 开始前读取当前状态

先在源码仓库根目录运行：

```bash
npm run list-themes
```

它会返回当前主题和主题库中每个主题的已有 revisions。还可以只读查看：

- `config/theme.json`：用户当前选择的主题 ID 和 revision。
- `themes/presets/*.json`：Agent 创建 Candidate 时可继承的官方 Preset。
- `themes/definitions/<theme-id>/<revision>.json`：已保存主题的只读定义。
- `themes/candidates/<theme-id>.json`：尚在编辑的候选，如果存在。

不要根据文件名猜测当前主题，也不要把 `themes/presets/` 与已经保存的主题库混为一体。

## 3. 权限边界

Agent 可以直接写入的主题文件只有：

```text
themes/candidates/<theme-id>.json
```

Agent 不得直接写入或覆盖：

- `config/theme.json`
- `themes/active.json`
- `themes/presets/`
- `themes/previews/`
- `themes/definitions/`
- `themes/compiled/`

用户可以让 Agent 完成主题切换；Agent 应调用本指南中的项目命令，由代码原子更新配置和运行时 Manifest。不要通过手工改写配置绕过校验。

`activate-theme`、`switch-theme` 和 `rollback-theme` 都会改变正式页面。只有用户在当前任务中明确要求相应操作时才能调用。

## 4. 查看与切换已有主题

查看主题库：

```bash
npm run list-themes
```

切换到目标主题的最新 revision：

```bash
npm run switch-theme -- --theme <theme-id> --confirm <theme-id>
```

切换到指定历史 revision：

```bash
npm run switch-theme -- --theme <theme-id> --revision <revision> --confirm <theme-id>
```

命令返回：

- `switched`：配置和 Active Theme 已一起切换。
- `unchanged`：目标就是当前选择，不需要改动。
- `rejected`：读取 `field` 和 `reason`；不要直接覆盖文件补救。

切换不需要 Candidate，不创建新 revision。目标 ID 或 revision 必须已经出现在 `list-themes` 结果中。

## 5. 新增或修改主题

新增主题时使用新的稳定 ID；修改主题时沿用原主题 ID。两种情况都只写一个 Candidate：

```text
themes/candidates/<theme-id>.json
```

文件名必须与 `id` 完全一致。示例：

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

使用要求：

- `schemaVersion` 固定为整数 `1`。
- `id` 只使用小写字母、数字和连字符。
- `extends` 只能引用 `themes/presets/` 中的官方 Preset，不能继承 Candidate。
- `tokens` 和 `recipes` 都必须存在，允许部分覆盖，但合计至少实际改变一个视觉值。
- 未知字段会被拒绝。
- 颜色只接受六位十六进制 `#RRGGBB`；合并后的主要文字和次要文字与背景对比度必须不低于 `4.5:1`。

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

## 6. 校验、预览与激活

Candidate 写完后运行：

```bash
npm run process-theme -- --candidate themes/candidates/<theme-id>.json
```

结果为 `preview-ready` 或 `unchanged` 时，启动本地页面并检查：

```text
http://127.0.0.1:4173/?themePreview=<theme-id>
http://127.0.0.1:4173/?themePreview=<theme-id>&themeStress=1
```

自动检查通过只代表主题合法，不代表用户认可审美。向用户展示预览并获得针对当前 Candidate 的明确确认后，才能运行：

```bash
npm run activate-theme -- --theme <theme-id> --confirm <theme-id>
```

激活会保存一个新的不可变 revision，并把它设为当前主题；其他主题和旧 revision 保持不变。未获得明确确认时，停在预览阶段。

回到上一次正式选择：

```bash
npm run rollback-theme -- --confirm
```

## 7. 禁止内容

Candidate 不得包含 HTML、CSS、CSS 选择器、JavaScript、`style`、`@import`、`url()`、远程资源、字体地址、DOM、网格坐标、总栏数、模块所占栏数、断点、隐藏内容规则、负间距、绝对定位、`z-index`、revision、激活或回滚指令。

主题任务不得修改：

- 日报内容、来源或编辑顺序
- `editorial.priority`
- 大、中、小模块映射
- Layout Compiler 输出
- `data/issues/`、`data/compiled/` 或 `data/index.json`

## 8. Agent 完成条件

按任务类型判断完成：

- **查看**：已返回主题库和当前选择。
- **切换**：命令返回 `switched` 或 `unchanged`，且再次运行 `list-themes` 能看到目标为当前选择。
- **新增或修改**：Candidate 校验成功、真实日报与压力页面已预览；只有用户确认后才要求激活成功。
- **回滚**：命令返回 `rolled-back`，且当前选择与返回结果一致。

任何命令返回 `rejected` 时，保留 Candidate 和全部正式主题，报告具体字段与原因，不绕过项目命令直接改写正式文件。
