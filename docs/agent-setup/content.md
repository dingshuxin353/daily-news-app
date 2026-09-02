# DailyNews Content API 操作合同

- API Base URL：`{{API_BASE_URL}}`
- 所有请求：`Authorization: Bearer <用户提供的 DailyNews Agent Token>`
- JSON 写入：`Content-Type: application/json` 与 `Idempotency-Key: <8–80 位稳定 key>`

本文说明日报内容的读取和写入。每次写入前都先读取当前 Publication 和 Daily Context，并使用 Context 返回的 Schema 版本、限制与确认规则。

## 请求顺序

1. `GET {{API_BASE_URL}}/publications`
2. `GET {{API_BASE_URL}}/publications/{publicationId}/daily-context`；需要明确日期时附加 `?date=YYYY-MM-DD`
3. `POST {{API_BASE_URL}}/publications/{publicationId}/daily-candidates`
4. `GET {{API_BASE_URL}}/publications/{publicationId}/issues/{date}`

先从 Publication 列表选择默认项或用户明确指定的活动项。不要自己构造 Space、Publication 或日期；缺省日期由服务端按目标 Publication 时区解析。

## 读取 Daily Context

Context 会返回目标 Publication、时区、解析后的绝对日期、当前正式 Issue、优先级限制和写入规则。生成 Candidate 时遵守返回的 `writeRules`，并使用当前支持的 `schemaVersion`。

如果 Publication 已停用，可以读取既有正式 Issue，但不能创建新写入。未知、跨租户或不存在的目标按 `404 target_not_found` 处理，不探测其他 ID。

## 提交 Content Candidate

请求正文的顶层结构固定为：

```json
{
  "mode": "update",
  "confirmation": {
    "historicalDate": null,
    "replace": null
  },
  "candidate": {
    "schemaVersion": 2,
    "date": "YYYY-MM-DD",
    "generatedAt": "RFC3339 timestamp",
    "coverage": {
      "start": "RFC3339 timestamp",
      "end": "RFC3339 timestamp"
    },
    "items": []
  }
}
```

`candidate.items` 按 Context 当前合同生成；每项至少提供稳定 `id`、`title`、`brief`、`summary`、`editorial` 和 `sources`。来源 URL 必须是实际 HTTP(S) 来源。不要提交用户 Token、私有配置或凭证材料。

- 普通创建和修正使用 `mode: "update"`。
- 历史日期必须先取得用户对精确日期的明确确认，并让 `confirmation.historicalDate` 与 Candidate 日期完全一致。
- `mode: "replace"` 只用于替换已存在的正式 Issue；必须先取得用户对 Publication、日期和影响的明确确认，并在 `confirmation.replace` 中提交 `publicationId`、`date` 与刚从 Context 读取的 `expectedRevision`。
- 同一个 `Idempotency-Key` 只能代表同一个 Method、URL 和完全相同的 JSON。网络重试复用原 key；新的内容意图使用新 key。

成功响应会给出 `result`、`publicationId`、`date`、正式 `revision`、`warnings`、`pageUrl` 和 `requestId`。随后必须通过正式 Issue 路径读回同一日期；只有正式 Issue / Compiled 已可读取，才算本次内容写入完成。

## 冲突与恢复

- `400 schema_invalid` 或 `invalid_request`：按 Context 与错误字段修正；修正后的正文是新意图，使用新 key。
- `409 revision_conflict`：重新读取 Context；如仍需替换，重新取得用户对最新 revision 的确认并使用新 key。
- `409 explicit_confirmation_required`：停止写入，向用户确认精确目标和影响。
- `409 publication_inactive`：停止新写入；可以读取已有正式归档。
- `409 idempotency_conflict`：原 key 已绑定其他请求；不要覆盖，核对原意图并为真正的新意图使用新 key。
- `429`：遵守 `Retry-After`。
- `5xx`、超时或响应不确定：先复用原 key 和完全相同请求安全重试，或读取正式 Issue 判断结果；不要用新 key 盲目重复提交。

不要把 Candidate 校验通过说成正式日报已经形成，也不要在无法确认写入结果时向用户报告成功。
