# M3-E 独立集成测试框架

本目录只负责 M3-E 的真实环境编排和脱敏证据采集，不修改应用源码，不启动 PostgreSQL、Node 服务或任何调度器。

## 安全边界

- PAT 只能通过 `M3E_PAT_FILE`、`M3E_OLD_PAT_FILE` 或 `M3E_NEW_PAT_FILE` 指定的仓库外部私有文件读取。文件必须是普通文件，权限不能向组用户或其他用户开放。
- 不接受命令行 PAT，不打印 PAT，不把 Authorization、Cookie、Session、Token、Secret、凭证字段写入报告或证据。
- Candidate、需求和调度事件文件也必须位于仓库外部并使用私有权限；JSON 输入包含敏感字段时会在发送或写证据前拒绝。
- 运行证据只写入 `test-results/m3-e/`，该目录已被 Git 忽略；证据只保留状态、时间、哈希、requestId、revision 和固定错误码等摘要。
- `M3E_MCP_URL` 和可选的 `M3E_JSON_API_URL` 必须是不带 userinfo、query 或 hash 的 `http`/`https` URL。运行器使用真实 `fetch` 和官方 `@modelcontextprotocol/client@2.0.0`，不会改写为 Hono `app.request`。

## 真实 MCP 运行器

先准备真实监听端点和仓库外的私有 PAT 文件，再执行只读发现：

```bash
M3E_MCP_URL=http://127.0.0.1:3000/mcp \
M3E_PAT_FILE=/private/path/dailynews-pat.txt \
npm run test:m3e:live -- --phase inspect --era both
```

可用阶段：

- `inspect`：连接并发现六个工具，读取 Daily / Todo Context。
- `daily`：读取 Context，提交仓库外 Candidate，读取正式 Issue / Compiled Edition；设置 `M3E_JSON_API_URL` 时还会用同一 `clientRunId` 做 JSON API 重放。
- `todo`：读取 Todo Context；启用时提交 Candidate 并读取正式 State，关闭时只记录 disabled，不提交或读取正文。
- `full`：执行 Daily 与 Todo 两条闭环。
- `credential-cutover`：用 `M3E_OLD_PAT_FILE` 与 `M3E_NEW_PAT_FILE` 验证撤销后的旧 PAT 被拒绝、轮换后的新 PAT 可用。

写入阶段还需要：

```bash
M3E_MCP_URL=http://127.0.0.1:3000/mcp \
M3E_PAT_FILE=/private/path/dailynews-pat.txt \
M3E_DAILY_CLIENT_RUN_ID=m3e-daily-run-0001 \
M3E_TODO_CLIENT_RUN_ID=m3e-todo-run-0001 \
npm run test:m3e:live -- --phase full --era modern \
  --daily-file /private/path/daily-candidate.json \
  --todo-file /private/path/todo-candidate.json \
  --requirements-file /private/path/requirements.txt
```

运行器只把 Candidate 的固定结果字段写入证据，不保存标题、正文、来源、任务标题或完整响应。相同 `clientRunId` 的第二次运行应由证据中的 `result` / `revision` 与 JSON API 重放结果判断幂等性。

## 定时运行证据

`record-schedule.js` 不创建定时任务，只验证由 Codex standalone cron automation 到点创建的独立本地任务 / 临时会话事实文件，并写入脱敏记录。它不唤醒已有线程。

```bash
npm run test:m3e:record-schedule -- \
  --event-file /private/path/scheduled-repeat.json \
  --requirements-file /private/path/requirements.txt
```

调度事件只允许记录以下事实：

```json
{
  "phase": "scheduled-repeat",
  "schedulerType": "codex-standalone-cron",
  "automated": true,
  "manualTrigger": false,
  "scheduledAt": "2026-08-30T09:00:00+09:00",
  "startedAt": "2026-08-30T09:00:03+09:00",
  "taskId": "m3e-task-20260830-090003",
  "sessionId": "m3e-session-20260830-090003",
  "mcpRunId": "m3e-run-20260830-090003",
  "requestId": "req_0123456789abcdef0123456789abcdef",
  "formalRevision": 2,
  "requirementSha256": "<64 位小写 SHA-256>"
}
```

`scheduled-repeat` 和 `changed-requirement` 必须由 `codex-standalone-cron` 在约定时间创建新的本地任务 / 临时会话，不能使用人工 `create_thread`、`send_message`、follow-up、固定 sleep、模拟时钟或一次性脚本冒充定时触发。`changed-requirement` 应使用修改后的需求文件哈希，并关联对应的 MCP 运行证据、requestId 和正式 revision。

## 当前运行前提

框架不会替代真实环境。M3-E 需要在真实 PostgreSQL 15、真实 `@hono/node-server` 回环监听、真实官方 MCP 客户端和真实 standalone cron 自动触发均可用后，补齐首轮、第二次定时运行和修改要求后的下一次运行证据。
