# DailyNews AI Agent 主题使用指南

指南版本：1.2
适用产品版本：0.12.0
Theme Schema：1
更新日期：2026-08-23

这份指南告诉外部 AI Agent 如何查看、切换、新增和修改 DailyNews 主题。它只规定 Agent 需要读取的信息、需要生成的文件和主题边界，不要求 Agent 运行主题处理命令或操作浏览器。

如果任务是生成或更新日报内容，请改读 [`AGENT_CONTENT_GUIDE.md`](./AGENT_CONTENT_GUIDE.md)。主题操作不能修改日报内容和布局。

站点与当前主题配置的说明见 [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md)。

## 1. 先判断任务类型

| 用户意图 | 正确操作 | 是否创建 Theme Revision |
| --- | --- | --- |
| 查看有哪些主题 | 读取当前配置与已保存 Definition | 否 |
| 切换到已有主题 | 确定目标主题 ID 与 revision | 否 |
| 新增一个主题 | 使用新 ID 生成 Candidate | 由后续流程创建 |
| 修改已有主题 | 使用原 ID 生成 Candidate | 由后续流程增加 |
| 回到上一次选择 | 确定上一次主题 ID 与 revision | 否 |

切换不是覆盖：所有正式主题都保存在 `themes/definitions/<theme-id>/<revision>.json`，旧主题和旧 revision 不会因为切换而删除。

### 从用户语言解析主题意图

Agent 能读取主题库时，应自己解析主题 ID 和 revision，不要求普通用户提供技术值：

| 用户表达 | 目标行为 |
| --- | --- |
| “跟首页一样”“恢复跟随首页” | 目标 Publication 显式切换为 `inherit` |
| “这份日报单独用深色科技” | 从主题库选择合适的深色主题，并把目标 Publication 切换为 `override` |
| “首页换成简洁风格” | 选择匹配的已有主题并切换 Home；所有 `inherit` Publications 随之变化 |
| “换回上一个主题” | 只对用户明确的 Home 或 Publication 执行受控回滚 |
| “做一个新的蓝色财经风格” | 生成 Theme Candidate，后续先预览，再由用户确认是否激活 |

如果同一句话无法唯一判断目标是 Home 还是某份日报，先用人类名称确认目标。Agent 可以在确认摘要中补充解析出的主题 ID 和 revision，但不能反过来要求用户先选择它们。

## 2. 开始前读取当前状态

开始前只读查看：

- 用户或宿主明确给出的唯一目标 Publication ID。
- `config/home.json`：Home 当前固定的主题 ID 和 revision。
- `publications/<publication-id>/config/theme.json`：目标日报是继承 Home，还是独立覆盖固定主题。
- `themes/presets/*.json`：Agent 创建 Candidate 时可继承的官方 Preset。
- `themes/definitions/<theme-id>/<revision>.json`：已保存主题的只读定义。
- `themes/candidates/<theme-id>.json`：尚在编辑的候选，如果存在。

不要根据文件名猜测当前主题，也不要把 `themes/presets/` 与已经保存的主题库混为一体。

如果 Agent 所在环境支持项目命令，可以使用 `npm run list-themes -- --publication <publication-id>` 辅助读取主题库；这不是完成任务的必要条件。

## 3. 权限边界

Agent 可以直接写入的主题文件只有：

```text
themes/candidates/<theme-id>.json
```

Agent 不得直接写入或覆盖：

- `publications/*/config/theme.json`
- `publications/*/themes/active.json`
- `themes/presets/`
- `themes/previews/`
- `themes/definitions/`
- `themes/compiled/`

用户可以让 Agent 完成主题切换。支持项目命令的环境可以调用受控切换入口；不支持命令的环境只需明确交付目标主题 ID 和 revision，由宿主环境完成正式切换。不要手工覆盖正式主题文件。

切换和回滚都会改变正式页面。只有用户在当前任务中明确要求相应操作时，Agent 才能提交对应目标或调用受控入口。

## 4. 查看与表达切换目标

Effective Theme 来自 Home 固定主题和目标 Publication 的 `inherit` / `override` 选择，可用主题来自全局 `themes/definitions/`。Agent 应先确认唯一目标是 Home 还是某个 Publication，并确认目标 ID 和 revision 已存在。

如果所在环境支持项目命令，可以使用：

```bash
npm run list-themes -- --publication <publication-id>
```

切换到目标主题的最新 revision：

```bash
npm run switch-theme -- --publication <publication-id> --theme <theme-id> --confirm <theme-id>
```

切换到指定历史 revision：

```bash
npm run switch-theme -- --publication <publication-id> --theme <theme-id> --revision <revision> --confirm <theme-id>
```

显式恢复 Publication 继承，或切换 Home 固定主题：

```bash
npm run inherit-theme -- --publication <publication-id> --confirm
npm run switch-theme -- --home --theme <theme-id> --revision <revision> --confirm <theme-id>
```

命令返回：

- `switched`：配置和 Active Theme 已一起切换。
- `unchanged`：目标就是当前选择，不需要改动。
- `rejected`：读取 `field` 和 `reason`；不要直接覆盖文件补救。

不支持项目命令时，Agent 向宿主环境交付目标主题 ID 和 revision 即可。切换不需要 Candidate，也不创建新 revision。

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
- Candidate 不包含未知字段。
- 颜色只使用六位十六进制 `#RRGGBB`；主要文字和次要文字与背景对比度不低于 `4.5:1`。

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

## 6. Agent 与宿主环境的分工

Agent 新增或修改主题时，只负责把完整 Candidate 保存到 `themes/candidates/<theme-id>.json`，并向用户或宿主环境报告：

- Candidate 路径
- 主题 ID 与名称
- 继承的官方 Preset
- 本次修改的视觉方向和主要字段

Candidate 的后续处理、正式 revision 写入和当前主题更新由宿主应用、本地脚本、服务端任务或用户自己的工作流决定，不属于本指南的必做步骤。

这种分工不依赖 Agent 是否具备终端、浏览器或本地服务能力。

## 7. 禁止内容

Candidate 不得包含 HTML、CSS、CSS 选择器、JavaScript、`style`、`@import`、`url()`、远程资源、字体地址、DOM、网格坐标、总栏数、模块所占栏数、断点、隐藏内容规则、负间距、绝对定位、`z-index`、revision、激活或回滚指令。

主题任务不得修改：

- 日报内容、来源或编辑顺序
- `editorial.priority`
- 大、中、小模块映射
- Layout Compiler 输出
- `publications/*/data/issues/`、`publications/*/data/compiled/` 或 `publications/*/data/index.json`

## 8. Agent 完成条件

按任务类型判断 Agent 是否完成：

- **查看**：已返回主题库和当前选择。
- **切换**：已明确目标主题 ID 和 revision；支持项目命令时可以同时返回切换结果。
- **新增或修改**：Candidate 已保存到正确路径，并报告主题 ID、继承来源和主要变化。
- **回滚**：已明确上一次主题 ID 和 revision；支持项目命令时可以同时返回回滚结果。

Agent 不直接覆盖配置、正式 Definition、编译产物或 Active Manifest。
