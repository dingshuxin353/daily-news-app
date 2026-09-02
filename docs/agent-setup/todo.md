# DailyNews Personal Todo API 操作合同

- API Base URL：`{{API_BASE_URL}}`
- 所有请求：`Authorization: Bearer <用户提供的 DailyNews Agent Token>`
- JSON 写入：`Content-Type: application/json` 与 `Idempotency-Key: <8–80 位稳定 key>`

本文说明 Personal Todo 的读取和写入。Todo 只有用户在浏览器设置中明确开启后才允许写入，Agent 不能自行开启。

## 请求顺序

1. `GET {{API_BASE_URL}}/todo`
2. `POST {{API_BASE_URL}}/todo/candidates`
3. 写入成功后再次 `GET {{API_BASE_URL}}/todo`

## 读取当前状态

未启用时，响应包含 `enabled: false`、Candidate 规则和 `settingsUrl`，不会返回保留 State 的正文、revision 或数量。此时只把不含凭证的设置链接交给用户；不要提交 Candidate，也不要推断保留数据。

启用后，响应包含当前正式 State、`revision`、Candidate 限制和页面链接。每次写入前都读取最新响应，并以它作为 `baseRevision` 的来源。

## 提交 Todo Candidate

请求正文的顶层结构固定为：

```json
{
  "candidate": {
    "schemaVersion": 1,
    "candidateId": "agent-generated-stable-id",
    "generatedAt": "RFC3339 timestamp",
    "baseRevision": 1,
    "operations": []
  }
}
```

`candidateId` 是 Candidate 的稳定标识，不等于请求头中的 `Idempotency-Key`。`operations` 只使用当前响应公布的限制和以下操作合同：

- `add`：提供新的 `clientId` 和 `title`；可按当前 Schema 提供 `note`、`dueDate`、`dueTime`。
- `update`：提供已有 `taskId` 与 `changes`。
- `complete`、`reopen`、`archive`、`restore`：提供已有 `taskId`。

不要提交服务端未返回的 `taskId`，不要直接写正式 State，也不要在 Todo disabled 时探测保留内容。

成功响应会给出处理结果、`schemaVersion`、`candidateId`、`baseRevision`、正式 `revision`、操作结果、警告、处理时间、页面链接和 `requestId`。随后重新读取当前 Todo，确认正式 revision 与 State。

## 冲突与恢复

- `409 todo_disabled`：停止写入，引导用户打开响应提供的设置页；不要自行启用。
- `409 revision_conflict`：重新读取当前 Todo，基于最新 State 重新生成 Candidate；这是新意图，使用新的 Candidate ID 和 Idempotency-Key。
- `409 idempotency_conflict`：原 key 已绑定其他请求；不要覆盖。
- `400 schema_invalid` 或 `invalid_request`：按错误与最新规则修正；修改后的正文使用新 key。
- `429`：遵守 `Retry-After`。
- `5xx`、超时或响应不确定：相同意图复用原 key 和完全相同请求，或先读取当前 Todo 判断正式 revision；不要用新 key 盲目重复操作。

Todo 被关闭后不得读取或回显保留正文。只有重新读取到正式 State 的预期变化，才向用户报告任务更新完成。
