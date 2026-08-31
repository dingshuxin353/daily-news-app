# DailyNews Agent API 与高级 MCP

状态：`v1.0.0` M5 Agent 接入技术合同；具体环境是否部署以该环境的运行版本为准。

DailyNews 的普通 Agent 接入采用 HTTPS JSON API；远程 MCP 保留为高级协议能力，不进入普通接入说明或首次连接门槛。两种协议使用设置页一次性签发的同一枚 Personal Access Token（PAT）。浏览器 Cookie 不能代替 PAT，PAT 也不能打开浏览器私有页面。请从 DailyNews 设置中读取真实 API Base URL；高级 MCP 客户端再读取 MCP URL。下面的域名、Token 和内容都是假数据。

## 安全与重试

- 请求头使用 `Authorization: Bearer <PAT>`；不要把 PAT 放进 URL、Candidate、日志、项目文件或聊天回复。
- GET 与 DELETE 不需要请求 `Content-Type`。POST / PUT 只接受 `application/json`；所有写入都必须带 `Idempotency-Key`。
- 同一次网络重试复用同一个 key 和完全相同的 JSON；新的用户意图使用新 key。相同 key 携带不同正文会返回 `409 idempotency_conflict`。
- 响应中的私有页面链接不含凭证；用户打开时仍需自己的浏览器 Session。
- `401 invalid_token` 不区分错误、过期、轮换或撤销；创建或轮换目标连接密钥后重试。
- `429` 按 `Retry-After` 等待。`503` 使用原 key 与原正文安全重试。

机器可读契约位于 [`openapi-v1.yaml`](./openapi-v1.yaml)。该文件使用 JSON 表示法保存；JSON 是 YAML 1.2 的合法子集。

## 普通 API-first 接入

普通 Agent 的唯一入口是当前实例的 `GET /agent-setup.md`。该 Markdown 只注入当前部署的绝对 API Base URL，并按业务能力链接三份固定文档：

- `/agent-setup/content.md`：Publication、Daily Context、Content Candidate 与正式 Issue。
- `/agent-setup/todo.md`：Todo Context、Candidate 与正式 State。
- `/agent-setup/theme.md`：Theme Context 与自定义主题 CRUD。

Agent 先确认宿主能发送带 Header 与 JSON Body 的 HTTPS 请求，再读取当前任务需要的功能文档，然后请用户创建一次性可见的 Token。最小连接验证是使用 Bearer Token 调用 `GET /publications`，再读取目标 Publication 的 Daily Context。普通路径不配置客户端协议、不修改客户端文件、不要求重新加载，也不安装脚本运行时或插件。

功能文档只暴露现有 JSON API 的方法、路径、Header、Schema 使用顺序、幂等与错误恢复规则。它们不复制完整业务 Schema；运行时约束以 Context 响应为准，机器集成以 OpenAPI 为准。所有文档都使用明确登记的固定路由，不扫描目录，也不建立 JSON discovery。

## 高级远程 MCP

MCP 端点是 Agent 授权页和接入说明中的绝对 `mcpUrl`，路径通常为 `/mcp`。它使用官方 `@modelcontextprotocol/server@2.0.0` 的单一 Server Factory，同时服务现代 `2026-07-28` 与无状态兼容 `2025-11-25`；不会生成 `Mcp-Session-Id`，也不提供 GET 事件流。Agent Token 是 DailyNews 自定义 Bearer PAT，不是 MCP OAuth Token。

十一个工具由两代协议共用同一业务和幂等状态：

| 工具 | 作用 |
| --- | --- |
| `get_daily_context` | 解析默认或指定 Publication、绝对日期、可写状态和确认边界 |
| `submit_daily_candidate` | 校验 Candidate，并更新正式 Issue 与 Compiled Edition |
| `get_daily_issue` | 读取指定日期的正式 Issue 与 Compiled Edition |
| `get_todo_context` | 读取 Todo 是否启用、当前 revision 和 Candidate 限制 |
| `submit_todo_candidate` | 校验 Candidate，并更新正式 Todo State |
| `get_todo_state` | 读取最新正式 Todo State；未启用时返回 `todo_disabled` |
| `get_theme_context` | 读取 Theme Schema、约束、官方 / 自定义主题及使用关系 |
| `get_theme` | 读取一个可见主题的 current definition、revision 与使用关系 |
| `create_theme` | 校验、编译并原子创建自定义主题 revision 1 |
| `update_theme` | 使用 `baseRevision` 原子推进自定义主题 current revision |
| `delete_theme` | 删除未使用的自定义主题当前目录项，保留历史 revision |

所有工具都返回严格 `outputSchema`、`structuredContent`、简短文本摘要和 `requestId`。读取工具声明为只读且不产生业务副作用；Daily、Todo 与主题写入工具都声明为幂等。Daily 的 `replace` 与主题删除声明为可能产生破坏性变化。

### 客户端配置

先确认客户端支持 Streamable HTTP MCP。优先选择 `2026-07-28`；只支持 `2025-11-25` 的客户端仍可使用无状态兼容路径。客户端应把 PAT 存入自身的 Secret / 环境变量设施，不能写进项目配置、聊天内容或 URL。不同客户端的字段名不属于 MCP 通用协议，必须查阅该客户端文档。

例如 Codex 的远程 MCP 配置使用环境变量保存 Token；下例只演示 Codex 格式：

```toml
[mcp_servers.dailynews]
url = "https://dailynews.example/mcp"
bearer_token_env_var = "DAILYNEWS_PAT"
```

```bash
export DAILYNEWS_PAT='dnpat_example_only_never_use_this_value'
```

连接后先执行 `get_daily_context`、`get_todo_context`；处理主题时先执行 `get_theme_context`。未指定日报时，`get_daily_context` 会解析默认项并返回小规模 `availablePublications`；后续写入仍必须使用明确的 `publicationId` 与绝对日期。Content Candidate、Todo Candidate 与主题定义不能混用，也不能指定 Space 或直接写正式状态。

### 高级协议使用边界

远程 MCP 是已存在的高级接入选择，适合已经明确采用该协议的客户端和集成方。它不由普通 `/agent-setup.md` 引导，不作为普通 Agent 首次连接的前提，也不需要为每种客户端新增公开手册。使用高级协议时，仍以本节的正式端点、工具 Schema、认证、幂等和安全规则为准。

### MCP Inspector 基线

基线锁定 `@modelcontextprotocol/inspector@2.4.0`。在可信本机终端设置真实 URL 和 PAT，再检查工具清单与 Schema；命令参数会短时存在于本机进程信息中，不要在共享机器执行，也不要保存含真实 Token 的输出。

```bash
export DAILYNEWS_MCP_URL='https://dailynews.example/mcp'
export DAILYNEWS_PAT='dnpat_example_only_never_use_this_value'

npx --yes @modelcontextprotocol/inspector@2.4.0 --cli \
  --transport http \
  --server-url "${DAILYNEWS_MCP_URL}" \
  --header "Authorization: Bearer ${DAILYNEWS_PAT}" \
  --method tools/list \
  --strict \
  --format json

npx --yes @modelcontextprotocol/inspector@2.4.0 --cli \
  --transport http \
  --server-url "${DAILYNEWS_MCP_URL}" \
  --header "Authorization: Bearer ${DAILYNEWS_PAT}" \
  --method tools/call \
  --tool-name get_daily_context \
  --tool-args-json '{}' \
  --format json
```

撤销或轮换后，旧 PAT 在 MCP 与 JSON API 中都会统一得到 `401 invalid_token`；把新 PAT 更新到客户端的安全存储并重新连接即可恢复。不要把旧 Token 保留为备用路径。

## Content 闭环

先读取 Publication，再读取目标日期上下文。日期缺省时，服务端按目标 Publication 时区解析今天：

```bash
export DAILYNEWS_API_BASE='https://dailynews.example/api/v1'
export DAILYNEWS_PAT='dnpat_example_only_never_use_this_value'

curl --fail-with-body \
  -H "Authorization: Bearer ${DAILYNEWS_PAT}" \
  "${DAILYNEWS_API_BASE}/publications"

curl --fail-with-body \
  -H "Authorization: Bearer ${DAILYNEWS_PAT}" \
  "${DAILYNEWS_API_BASE}/publications/daily-news/daily-context?date=2026-08-27"
```

提交假数据示例：

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${DAILYNEWS_PAT}" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: fake-daily-run-20260827' \
  "${DAILYNEWS_API_BASE}/publications/daily-news/daily-candidates" \
  --data-binary @- <<'JSON'
{
  "mode": "update",
  "confirmation": {
    "historicalDate": null,
    "replace": null
  },
  "candidate": {
    "schemaVersion": 2,
    "date": "2026-08-27",
    "generatedAt": "2026-08-27T08:00:00+08:00",
    "coverage": {
      "start": "2026-08-26T08:00:00+08:00",
      "end": "2026-08-27T08:00:00+08:00"
    },
    "items": [{
      "id": "example-update",
      "title": "示例产品发布新版本",
      "brief": "这是只用于接口演示的虚构内容。",
      "summary": "示例团队发布了一个虚构版本，用于说明 Content Candidate 字段。",
      "editorial": {
        "priority": "lead",
        "selectionReason": "演示稳定字段与来源结构"
      },
      "sources": [{
        "name": "Example Source",
        "url": "https://example.com/fake-dailynews-story"
      }]
    }]
  }
}
JSON
```

提交成功后，使用响应中的 `date` 和 `publicationId` 读取同一正式 revision：

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${DAILYNEWS_PAT}" \
  "${DAILYNEWS_API_BASE}/publications/daily-news/issues/2026-08-27"
```

历史日期必须令 `confirmation.historicalDate` 与 Candidate 日期完全一致。`replace` 只允许替换已经存在的 Issue，并必须同时绑定 `publicationId`、`date` 和刚从 Context 读取的 `expectedRevision`。锁内 revision 已变化时会返回 `409 revision_conflict`，需要重读并再次取得用户确认。普通修正使用 `update`。

## Personal Todo 闭环

先读取 Todo。未启用时只返回 `enabled: false`、Candidate 规则和绝对设置链接，不返回保留 State 的 revision、数量或正文；Agent 不能自行启用。

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${DAILYNEWS_PAT}" \
  "${DAILYNEWS_API_BASE}/todo"
```

用户在浏览器明确启用后，可以提交假数据示例：

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${DAILYNEWS_PAT}" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: fake-todo-run-20260827' \
  "${DAILYNEWS_API_BASE}/todo/candidates" \
  --data-binary @- <<'JSON'
{
  "candidate": {
    "schemaVersion": 1,
    "candidateId": "example-todo-run",
    "generatedAt": "2026-08-27T09:00:00+08:00",
    "baseRevision": 0,
    "operations": [{
      "type": "add",
      "clientId": "draft-one",
      "title": "提交示例周报",
      "dueDate": "2026-08-28"
    }]
  }
}
JSON
```

Todo 的 `candidateId` 仍是领域标识；`Idempotency-Key` 会规范化为跨 JSON API / MCP 共用的 `clientRunId`。两者不能互相冒充。出现 `409 revision_conflict` 时，重新 GET `/todo`，用最新 `baseRevision` 生成新的 Candidate，并为新意图使用新 key。

## 自定义主题闭环

先读取 `/themes/context`，再按需读取 `/themes/{themeId}`。创建、修改、删除的声明式 Schema、`baseRevision`、`If-Match`、假数据示例与稳定错误处理见根目录 [`AGENT_THEME_GUIDE.md`](../AGENT_THEME_GUIDE.md)。云端没有 Theme Candidate、预览或网页确认路径；Agent 不能修改官方主题或 Home / Publication 的浏览器选择。

## 当前固定限制

`config/cloud.json` 固定首个部署默认值：JSON API 与 MCP 请求体各 256 KiB；两种协议共用每枚 PAT 每小时读取 600 次、写入 120 次，以及每个受信客户端 IP 每小时读取 1200 次、写入 240 次；每个 Content Candidate 最多 100 条内容，每个 Todo Candidate 最多 100 个操作；每个 Space 最多 24 个当前自定义主题、2 个并发 Agent 写入。限流事件保留 24 小时，Candidate / Submission 幂等回执保留 90 天，写入租约最长 5 分钟，`last_used_at` 最多每 5 分钟节流更新一次。

这些数值属于部署边界，不改变 Candidate、Writer、Compiler 或正式数据语义。
