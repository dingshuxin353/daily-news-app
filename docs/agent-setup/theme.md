# DailyNews Theme API 操作合同

- API Base URL：`{{API_BASE_URL}}`
- 所有请求：`Authorization: Bearer <用户提供的 DailyNews Agent Token>`
- JSON 写入：`Content-Type: application/json` 与 `Idempotency-Key: <8–80 位稳定 key>`

本文说明自定义 Theme 的读取与写入。每次操作都先读取当前 Theme Context，并以响应中的 `themeSchema`、约束、current revision 与使用关系为准；不要复制或猜测完整 Theme 定义。

## 操作顺序

1. `GET {{API_BASE_URL}}/themes/context`
2. `GET {{API_BASE_URL}}/themes/{themeId}`
3. `POST {{API_BASE_URL}}/themes`
4. `PUT {{API_BASE_URL}}/themes/{themeId}`
5. `DELETE {{API_BASE_URL}}/themes/{themeId}`

官方主题优先且只读。自定义主题按当前用户 Space 隔离；不要探测其他租户的 ID。主题选择与 Publication / Home 的继承关系由浏览器设置管理，Agent 只维护自定义主题定义。

## 读取 Context 与主题

Theme Context 返回当前 `themeSchema`、约束、官方与自定义主题、current revision 和使用关系。创建或修改前，按 `themeSchema` 生成定义；更新或删除前，再读取目标主题的最新 current revision。

## 创建

`POST /themes` 的正文为：

```json
{
  "theme": {}
}
```

`theme` 必须符合刚读取的 `themeSchema` 与约束。成功时创建自定义主题 current revision 1，并返回正式结果与 `requestId`。

## 更新

`PUT /themes/{themeId}` 的正文为：

```json
{
  "baseRevision": 1,
  "theme": {}
}
```

`baseRevision` 必须等于刚读取的 current revision；路径 ID 与定义 ID 必须指向同一主题。每次成功更新只推进一个新 revision，历史 revision 保留。

## 删除

删除没有 JSON 正文，除 Authorization 与 Idempotency-Key 外还必须提供：

```http
If-Match: "<current positive revision>"
```

只有未被 Home 或任何 Publication 使用的自定义主题可以删除。删除会移除当前目录项，但保留历史 revision；不要把删除解释成历史数据被物理清除。

## 幂等、冲突与恢复

- 同一个 `Idempotency-Key` 只能代表同一个 Method、URL、Header 和完全相同的正文；DELETE 还包括相同 `If-Match`。
- `409 revision_conflict`：重新读取目标主题和 Context，基于最新 revision 形成新意图并使用新 key。
- `409 theme_read_only`：目标是官方主题，停止写入。
- `409 theme_in_use`：目标仍被 Home 或 Publication 使用；让用户先在浏览器设置中解除使用关系。
- `409 theme_limit_reached`：停止创建，引导用户管理现有自定义主题。
- `409 theme_conflict` 或 `idempotency_conflict`：不要覆盖现有事实，重新核对 ID、名称和原请求。
- `400 schema_invalid` 或 `invalid_request`：按最新 `themeSchema` 与错误修正；修改后的请求使用新 key。
- `429`：遵守 `Retry-After`。
- `5xx`、超时或响应不确定：复用原 key 与完全相同请求安全重试，或读取目标主题确认 current revision；不要用新 key 盲目推进 revision。

只有重新读取到预期的 current revision 或确认目录项已删除，才向用户报告主题操作完成。
