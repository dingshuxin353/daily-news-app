# DailyNews AI Agent 主题使用指南

指南版本：2.0

适用产品版本：云端 `1.0.0`；本地文件模式 `0.12.1`

Theme Schema：1
更新日期：2026-08-29

这份指南告诉外部 AI Agent 如何查询和维护 DailyNews 主题。主题只能改变声明式视觉 Token 与 Recipe，不能修改日报内容、布局骨架、页面源码或浏览器主题选择。

开始前先判断宿主提供的是哪一种接入方式：

- 云端 `1.0.0`：使用远程 MCP 或 HTTPS JSON API。自定义主题由服务端校验、编译并在一个 PostgreSQL 事务中保存；没有 Theme Candidate、网页预览或确认步骤。
- 本地文件模式 `0.12.1`：继续使用仓库内 Theme Candidate、预览和用户确认流程。不要把这套文件路径或命令用于云端。

生成日报内容请改读 [`AGENT_CONTENT_GUIDE.md`](./AGENT_CONTENT_GUIDE.md)。

## 1. 云端主题能力

优先使用 MCP。宿主只提供 HTTPS JSON API 时，使用设置页给出的 API Base URL 与独立 PAT；不要把 PAT 写入聊天、日志、截图、命令历史或项目文件。

| 意图 | MCP | JSON API |
| --- | --- | --- |
| 读取 Schema、主题库和使用关系 | `get_theme_context` | `GET /themes/context` |
| 读取当前主题定义 | `get_theme` | `GET /themes/{themeId}` |
| 创建自定义主题 | `create_theme` | `POST /themes` |
| 修改自定义主题 | `update_theme` | `PUT /themes/{themeId}` |
| 删除未使用的自定义主题 | `delete_theme` | `DELETE /themes/{themeId}` |

云端主题写入与日报、Todo 共用同一 PAT 鉴权、Space 归属、请求限流和并发写入边界。浏览器 Session 不能替代 PAT。

### 操作顺序

1. 每次写入前调用 `get_theme_context`，确认 Theme Schema、官方 Preset、配额和使用关系。
2. 修改或删除前再调用 `get_theme`，保存当前 `revision` 作为 `baseRevision`。
3. 把用户的视觉意图压缩到 Theme Schema 1 的 Token 与 Recipe；不能提交 HTML、CSS、JavaScript、URL、远程字体或布局指令。
4. 使用新的 `clientRunId` / `Idempotency-Key` 发起新意图；只有请求完全相同时才复用旧键。
5. 写入成功后读取主题，核对 `themeId`、current `revision` 和 `affected` 使用摘要。

创建从 revision `1` 开始。修改使用乐观并发：`baseRevision` 过期时重新读取，不得盲目覆盖。修改成功会推进 current revision，所有直接或通过 Home 继承使用同一主题 ID 的页面一起生效。

### 声明式主题示例

下面内容完全虚构，只用于说明字段：

```json
{
  "schemaVersion": 1,
  "id": "fictional-blue",
  "name": "虚构深蓝",
  "description": "只用于接口示例的虚构蓝色编辑主题。",
  "extends": "newspaper-default",
  "tokens": {
    "colors": { "accent": "#2457A7" },
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
    "normal": "accent"
  }
}
```

`extends` 必须是 `get_theme_context` 返回的官方主题 ID。颜色只接受六位十六进制 `#RRGGBB`；主要和次要文字与背景对比度至少为 `4.5:1`。`tokens` 与 `recipes` 都必须存在，并且合计至少真正覆盖一个官方 Preset 值。

### JSON API 写入

创建：

```bash
curl --request POST "$DAILYNEWS_API_BASE/themes" \
  --header "Authorization: Bearer $DAILYNEWS_PAT" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: theme-create-fictional-blue-01" \
  --data '{"theme":{"schemaVersion":1,"id":"fictional-blue","name":"虚构深蓝","extends":"newspaper-default","tokens":{"colors":{"accent":"#2457A7"}},"recipes":{"normal":"accent"}}}'
```

修改请求体为 `{"baseRevision":1,"theme":{...}}`，并使用新的幂等键发送到 `PUT /themes/fictional-blue`。

删除没有请求体；把 current revision 放进带双引号的 `If-Match`：

```bash
curl --request DELETE "$DAILYNEWS_API_BASE/themes/fictional-blue" \
  --header "Authorization: Bearer $DAILYNEWS_PAT" \
  --header "Idempotency-Key: theme-delete-fictional-blue-01" \
  --header 'If-Match: "2"'
```

完整字段和响应以 [`docs/openapi-v1.yaml`](./docs/openapi-v1.yaml) 为准。

### 失败恢复

- `revision_conflict`：重新读取主题，用新 revision 和新幂等键表达仍然成立的意图。
- `idempotency_conflict`：旧键已绑定另一请求；核对意图后换新键，不能改正文后复用旧键。
- `theme_read_only`：官方主题不可修改或删除；如需变化，创建一个继承它的自定义主题。
- `theme_in_use`：主题仍被 Home、活动或停用日报使用；请用户先在浏览器选择其他主题，再重试删除。
- `theme_limit_reached`：当前 Space 已达到自定义主题上限；由用户先调整并删除未使用主题。
- `schema_invalid`：修正声明式字段、官方继承、枚举或对比度；失败不会产生 revision，也不会改变正式页面。

删除成功只从当前目录与新选择中移除主题，历史 revision 仍由服务端保留。已删除 ID 不得通过“重新创建”覆盖历史。

## 2. 云端禁止边界

Agent 不能：

- 修改或删除官方主题。
- 修改 Home / Publication 的主题选择；选择由用户在浏览器设置中完成。
- 提交或生成 HTML、CSS、JavaScript、选择器、`style`、`@import`、`url()`、远程资源、字体地址、DOM、网格坐标、断点、隐藏规则、负间距、绝对定位或 `z-index`。
- 修改日报内容、来源、编辑顺序、`editorial.priority`、四格布局或 Todo 状态。
- 直接写数据库、Theme Revision、current 指针或主题选择。
- 把云端写入伪装成本地 Theme Candidate、预览或网页确认。

参考图只代表视觉意图。先映射到现有 Theme Schema；超出能力时说明限制并停止，不得因此修改共享页面源码。

## 3. 本地文件模式 `0.12.1`

本地发布基线继续使用历史文件流程：

```text
themes/candidates/<theme-id>.json
  → Validator / Compiler
  → themes/previews/
  → 用户确认
  → themes/definitions/ 与 themes/compiled/
```

主题 Agent 只能直接写 `themes/candidates/<theme-id>.json`。不得直接写：

- `config/home.json`
- `publications/*/config/theme.json`
- `publications/*/themes/active.json`
- `themes/presets/`
- `themes/previews/`
- `themes/definitions/`
- `themes/compiled/`

支持项目命令时，可以运行 `npm run process-theme -- <candidate-path>` 生成预览；只有用户明确确认该预览后，宿主才能运行受控激活命令。本地切换、继承和回滚继续使用仓库已有命令及其 `--confirm` 闸门。云端没有这些文件路径和确认动作。

## 4. 完成条件

- 查询：已返回主题库、来源、current revision 和使用关系。
- 创建：服务端返回 `created` 或完全相同重试的既有结果，并核对 revision `1`。
- 修改：服务端返回 `updated` / `unchanged`，并核对 current revision 与受影响目标。
- 删除：服务端返回 `deleted`，随后当前目录不再返回该主题；历史保留不由 Agent 操作。
- 失败：说明稳定错误与下一步，确认正式主题事实未被部分改变。
