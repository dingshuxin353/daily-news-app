# DailyNews Agent 接入说明

- 接入合同版本：`2.0.0`
- 适用产品：DailyNews `v1.0.0`
- 用途：让不了解 DailyNews 源码的 AI Agent 完成首次连接、恢复已有连接，并继续建立日报任务。

本文是 Agent 接入的唯一规范说明。不要搜索源码、猜测字段名，或把其他版本的接入说明与本文混用。

## 目标结果

完成本说明后，你应当：

1. 使用用户当前页面显示的一次性配对码认领一枚 DailyNews 凭证。
2. 在验证前把凭证保存到客户端提供的安全 Secret 存储。
3. 将凭证验证为 `active`，并连接 DailyNews MCP；只有明确采用高级 JSON API 路径时才使用 JSON API。
4. 读取日报、Todo 和主题上下文。
5. 询问用户长期关注范围和更新时间；只有客户端确实支持调度时才建立定时任务。
6. 立即生成第一份个性化日报，并把不含凭证的页面链接交给用户。

## 必须遵守的规则

- 先读取并遵守本文，再向用户索要配对码。
- 配对码和长期凭证都属于秘密。不得把它们输出到聊天回复、日志、项目文件、任务正文、URL 或错误报告。
- 配对码只能用于一次 Claim。收到 Claim `201` 后，无论后续步骤是否成功，都不得再次使用该配对码。
- Claim 成功返回的长期凭证只出现一次。必须先安全保存并确认可以重新读取，再执行 Verify。
- Verify 成功或活动凭证探测成功后，连接即为 `active`。后续运行直接恢复凭证，不再 Claim，也不再 Verify。
- `pairing_unavailable` 只说明本次配对码请求不可用，不能推翻本地已经保存的凭证或已经确认的 `active` 状态。
- 不得尝试 `connectionName`、`name`、`agent_name` 或其他猜测字段。Claim 只使用 `pairingCode` 和 `clientName`。
- 不得通过固定等待、延长配对码有效期、读取 DailyNews 源码或反复试错来完成接入。
- 如果当前客户端不能安全保存 Bearer Secret，应在索取配对码前停止，并明确告诉用户当前客户端无法安全完成连接。

## 当前服务地址

以下地址由当前 DailyNews 实例在运行时写入：

- Claim URL：`{{CLAIM_URL}}`
- Verify URL：`{{VERIFY_URL}}`
- API Base URL：`{{API_BASE_URL}}`
- MCP URL：`{{MCP_URL}}`
- MCP Transport：Streamable HTTP
- MCP Protocol：优先 `2026-07-28`；兼容 `2025-11-25`
- MCP Authorization：`Authorization: Bearer <DailyNews PAT>`

如果正文仍出现双花括号占位符，说明服务端接入说明无效。停止连接并向用户报告，不要自行猜测地址。

## 开始前检查

在向用户索取配对码前，确认当前环境具备：

1. 可访问 HTTPS（回环开发实例可以是 HTTP）的 GET 和 POST 能力。
2. 可以保存并在后续运行恢复 Bearer Secret 的安全存储。
3. 至少一种后续访问方式：远程 Streamable HTTP MCP，或已经明确选择的高级 JSON API 客户端。
4. 若要承诺每日自动更新，还必须具备本地持久定时任务能力。

缺少调度能力不妨碍建立连接，但必须告诉用户只能手动运行，不能声称已经设置每日自动更新。缺少安全 Secret 存储时不得继续 Claim。

## 持久状态

把长期凭证保存在 Secret 存储中。另行保存以下不含秘密的连接元数据，以便中断后恢复：

```json
{
  "service": "DailyNews",
  "contractVersion": "2.0.0",
  "credentialId": "<Claim 返回的 credentialId>",
  "verifyUrl": "{{VERIFY_URL}}",
  "apiBaseUrl": "{{API_BASE_URL}}",
  "mcpUrl": "{{MCP_URL}}",
  "phase": "provisioning"
}
```

`phase` 只允许：

- `provisioning`：Claim 已成功，Secret 已保存，尚未确认活动状态。
- `active`：Verify 返回 `200`，或活动凭证探测返回 `200`。

不要保存配对码。不要把长期凭证复制进这份非秘密元数据。

## 每次运行的入口

每次执行 DailyNews 任务时，先恢复本地状态，再决定下一步：

| 本地事实 | 下一步 |
| --- | --- |
| 找到 Secret，且 `phase = active` | 直接连接 MCP 并读取 Context；禁止 Claim 和 Verify |
| 找到 Secret，且 `phase = provisioning` | 先执行活动凭证探测；未激活时再执行一次 Verify |
| 找到 Secret，但没有可信 `phase` | 按“不确定状态恢复”处理：先探测 active，再决定是否 Verify |
| 没有 Secret | 执行能力检查，然后向用户索取当前配对码 |
| 曾发送 Claim，但没有收到可保存的 Token | 本次结果不可恢复；让用户回到页面结束或刷新本次连接并取得新码，禁止重用原码 |

本地已经存在有效连接时，不要因为用户再次粘贴了设置话术就创建第二枚凭证。

## 首次连接流程

### 1. 向用户索取配对码

完成能力检查后，只询问：“请把 DailyNews 页面当前显示的配对码发给我。”

使用用户提供的当前值，不读取旧消息中的历史配对码。页面显示五位、连字符、五位的短时代码；真实字符不会包含易混淆的 `0`、`1`、`I`、`L`、`O`。

### 2. 执行一次 Claim

请求：

```http
POST {{CLAIM_URL}}
Content-Type: application/json

{
  "pairingCode": "<用户页面当前显示的配对码>",
  "clientName": "Codex"
}
```

字段合同：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `pairingCode` | 是 | 用户页面当前显示的五位加五位配对码；原样发送 |
| `clientName` | 是 | 当前 Agent 或客户端的人类可读名称；去除首尾空白后 1–80 个 Unicode 字符，不含控制字符、U+2028 或 U+2029 |

只有以上两个字段属于合同。不要发送字段别名。

成功响应为 `201 Created`，`token` 是只返回一次的 provisioning PAT 明文：

```json
{
  "credentialId": "<新凭证 ID>",
  "token": "<只返回一次的 provisioning PAT>",
  "expiresAt": "<provisioning 到期时间>",
  "verifyUrl": "{{VERIFY_URL}}",
  "apiBaseUrl": "{{API_BASE_URL}}",
  "mcpUrl": "{{MCP_URL}}",
  "requestId": "<请求 ID>"
}
```

收到 `201` 后立即执行以下本地动作，不再触碰配对码：

1. 把 `token` 写入安全 Secret 存储。
2. 从安全存储重新读取并确认该 Secret 存在；不得在输出中显示它。
3. 保存不含 Secret 的连接元数据，`phase` 设为 `provisioning`。
4. 使用响应实际返回的 `verifyUrl`、`apiBaseUrl` 和 `mcpUrl` 覆盖说明页中的地址。

如果本地保存第一次失败，可以继续保存同一个内存中的 Token；不得重新 Claim。最终仍无法安全保存时，停止并让用户在 DailyNews 页面取消本次连接，然后重新开始。

### 3. 执行 Verify

只有安全存储已经成功后才能 Verify。请求没有 Body，也不要发送 `Content-Type`：

```http
POST {{VERIFY_URL}}
Authorization: Bearer <已安全保存的 DailyNews PAT>
```

成功响应为 `200 OK`：

```json
{
  "status": "active",
  "credential": {
    "id": "<凭证 ID>",
    "name": "Codex",
    "status": "active",
    "createdAt": "<创建时间>",
    "lastUsedAt": "<最近使用时间或 null>"
  },
  "context": {
    "publicationId": "daily-news",
    "publicationName": "DailyNews",
    "timeZone": "Asia/Shanghai",
    "todoEnabled": false
  },
  "requestId": "<请求 ID>"
}
```

收到 `200` 后，把本地 `phase` 原子更新为 `active`。Verify 是一次性的；成功后再次调用会得到 `401`，这不表示连接失败。

状态变化必须理解为：Pairing 从 `pending` 进入 `claimed`，同时 Credential 进入 `provisioning`；Verify 成功后 Pairing 进入 `verified`，同时 Credential 进入 `active`。

### 4. 连接并读取 Context

优先使用返回的 `mcpUrl` 建立 Streamable HTTP MCP 连接，并从安全存储注入 Bearer Token。连接后：

1. 发现工具，不要凭记忆猜测工具输入。
2. 调用 `get_daily_context`。
3. 调用 `get_todo_context`。
4. 处理主题时调用 `get_theme_context`。

如果 MCP 连接失败，但活动凭证探测成功，保留 `active` 状态并只排查 MCP 配置；不要重新配对。

### 5. 完成用户任务

连接成功后继续：

1. 用普通语言询问用户长期关注的内容。
2. 询问更新时间，把“每天早上”等相对表达复述为明确时间和时区并让用户确认。
3. 只有当前 Agent 确实支持持久调度时，才在 Agent 自己的环境建立或更新任务；DailyNews 服务端不托管调度。
4. 立即运行一次：先读 Context，再按 MCP 工具 Schema 提交 Candidate，最后读取正式结果。
5. 把不含 Token 的私有页面链接交给用户，并说明后续任务何时运行。

## 活动凭证探测

活动探测是只读请求，用于恢复不确定的 Verify 结果：

```http
GET {{API_BASE_URL}}/publications
Authorization: Bearer <已安全保存的 DailyNews PAT>
```

- 返回 `200`：凭证已经 `active`。把本地 `phase` 更新为 `active`，禁止 Verify。
- 返回 `401`，且本地 `phase` 为 `provisioning` 或未知：可以执行一次 Verify。
- 返回 `401`，且本地已可信记录 `phase = active`：凭证已经失效、撤销或轮换；不要 Verify，向用户请求建立新连接。
- 网络错误或 `5xx`：保持本地状态不变，停止变更操作并报告暂时无法确认；不要用 Verify 猜状态。

## 不确定状态恢复

| 发生情况 | 必须采取的动作 | 禁止动作 |
| --- | --- | --- |
| Claim 明确返回 `400 invalid_request`，消息指向 `clientName` | 修正 `clientName` 后可以使用仍在页面显示的同一码重新 Claim；该错误发生在配对码查找前 | 声称配对码已被服务端识别 |
| Claim 返回 `404 pairing_unavailable`，且本地没有 Token | 请用户发送页面当前显示的新码 | 猜测是过期、刷新还是已使用；反复提交旧码 |
| Claim 请求超时、连接断开，或响应缺少可保存的 Token | 告知用户结果不确定；若页面显示 Agent 正在准备连接则取消，若仍在等待则刷新配对码，然后使用新码重新开始 | 再次使用原配对码 |
| Claim `201` 后 Secret 保存失败 | 继续尝试保存同一个 Token；仍失败则让用户取消并重新配对 | 再次 Claim；先 Verify 后保存 |
| Verify 超时或响应丢失 | 使用活动凭证探测；`200` 即视为成功，`401` 时再 Verify 一次 | 直接再次 Verify；重新 Claim |
| Verify 返回 `401`，且活动探测也返回 `401` | 凭证已不可恢复；让用户取消或移除目标连接，再使用新码 | 延长 TTL、继续猜测或重用旧码 |
| 本地 `phase = active`，MCP 暂时不可用 | 保留凭证并排查网络、MCP URL 和协议支持 | 重新配对或撤销现有凭证 |
| 再次运行时已恢复 active Secret | 直接继续 MCP / Context / 定时任务 | 再向用户索码、再次 Claim 或 Verify |

## 错误解释

所有配对错误使用以下结构：

```json
{
  "error": {
    "code": "pairing_unavailable",
    "message": "配对码无效或已更新。",
    "requestId": "<请求 ID>"
  }
}
```

- `400 invalid_request`：请求正文或 `clientName` 不合法。只说明输入无效。
- `401 authentication_failed`：Verify 使用的凭证无效、已失效或已不是 provisioning；服务端不会进一步披露原因。
- `404 pairing_unavailable`：配对码当前不可用；服务端不会披露它是错误、过期、已刷新还是已使用。
- `409 credential_limit_reached`：当前用户的 Agent 授权槽位已满，需要用户先移除一项授权。
- `429 rate_limited`：遵守响应中的 `Retry-After`；不要使用固定等待。再次操作前确认用户页面仍显示当前配对码。
- `503 service_unavailable`：服务暂时不可用。保留已保存的本地状态，不创建备用连接。

错误响应不能覆盖已经由 Claim `201`、Verify `200`、活动探测 `200` 或本地安全存储证明的事实。需要向用户或维护者报告失败时，只提供阶段、错误 `code` 和 `requestId`；不要附带请求 Body、Authorization、配对码或私有业务响应。

## 完成条件

只有以下结果都真实发生，才能告诉用户 DailyNews 已经接入：

- 长期凭证已进入安全存储，聊天和项目文件中没有凭证明文。
- 凭证已经通过 Verify 或活动探测确认为 `active`。
- MCP 工具发现成功，并至少读取 Daily、Todo 与 Theme 的适用 Context；明确采用高级 JSON API 路径时，应完成等价只读上下文检查。
- Agent 已向用户确认关注范围、明确时间和时区。
- 如果声称自动更新，持久定时任务已经在 Agent 自己的环境真实建立。
- 第一份个性化日报已经形成正式结果，用户获得了不含凭证的页面链接。

仅仅“拿到配对码”“Claim 成功”“Verify 成功”或“保存了 MCP 配置”都不是完整用户旅程。

## 本说明不负责的内容

- 不降低一次性配对码、短时有效、Digest-only 存储、统一失败响应或凭证上限。
- 不托管 Agent、模型、内容搜集、提示词或定时任务。
- 不复制 Daily、Todo 和 Theme 的完整字段 Schema；连接后以 MCP 工具 Schema 和版本化 JSON API 契约为准。
- 不为不同 Agent 客户端维护字段猜测、旧 discovery 或兼容别名。
