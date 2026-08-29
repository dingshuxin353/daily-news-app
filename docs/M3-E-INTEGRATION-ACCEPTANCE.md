# M3-E 独立集成验收记录

状态：最终独立验收通过；用户于 2026-08-28 确认 M3 完成，验收框架经 PR #25 合入版本线。

## 1. 验收对象

- 独立分支：`test/v1-m3-integration`
- 精确基线：`origin/version/v1.0.0@734294e80efc349dd3a824ac0bcd9eed856743c2`
- 最终验收 head：`3e3ee2e44126ce42db917760df7eafce39452cd2`
- 合入结果：PR #25 以 Squash Merge 进入 `version/v1.0.0@20b0409e1f058e40840f7ad5f34d232f6b84882c`
- 基线内容：M3-A、M3-B、M3-C、M3-D 均已进入版本线；M3-D 的实际树与已验收 head 一致。
- 应用源码范围：本分支不修改 `src/`，只增加 `test/m3-e/` 框架、框架单测、验收文档和测试入口。
- 版本线 CI：[run 33131938811](https://github.com/dingshuxin353/daily-news-app/actions/runs/33131938811)。

## 2. 已有独立自动化与 CI 证据

在精确版本线提交上已独立执行或核对：

| 范围 | 结果 | 说明 |
| --- | --- | --- |
| 版本线基线核心测试 | 通过，120/120 | 覆盖既有本地模式和 M2 回归 |
| 本分支核心测试 | 通过，126/126 | 包含新增 6 项证据框架安全单测 |
| 云端单测 | 通过，41/41 | 覆盖 MCP 双时代、Schema、错误、Origin/Host/Socket 和安全负向 |
| 静态构建 | 通过 | `npm run build` |
| 云端构建 | 通过 | `npm run build:cloud` |
| 依赖审计 | 通过 | `npm audit --audit-level=high`，0 high vulnerabilities |
| PostgreSQL 集成 | CI 通过，46/46 | CI 使用 PostgreSQL 15 专用数据库 |
| 本机 PostgreSQL 集成 | 首轮收窄矩阵通过 | 用户提供的 PostgreSQL 15.19 已由正式服务使用；未运行依赖 `TEST_DATABASE_URL` 的仓库集成命令 |

现有 MCP 自动化使用官方 SDK，但其中的集成 transport 通过本地 `app.request` 或测试 App；它们是代码契约和协议回归证据，不替代真实监听端点上的外部客户端证据。

### 2.1 首轮真实本机结果（2026-08-28）

- 已独立核对用户提供的 manifest、PostgreSQL 15.19 和正式 `@hono/node-server` 服务；服务通过真实 TCP/HTTP 端点监听回环地址，数据库 migration 为 6/6。
- 官方 `@modelcontextprotocol/client@2.0.0` 通过真实 URL 完成 modern / legacy Discover、六工具发现、Instructions、Daily Context 和 Todo Context；两时代均无 MCP 会话头，六工具精确匹配。
- modern 首轮 Daily 写入成功，正式 Issue 与 Compiled Edition 均为 revision `1`；同一 `clientRunId` 的 JSON API 重放仍为 revision `1`，数据库只存在 1 条 Daily Submission、1 条 Issue 和 1 条 Compiled Edition。
- Todo disabled 两时代均只记录 `enabled=false` 并跳过写入；JSON API 只读响应不含保留 State 字段。真实 HTTP 负向检查和 JSON API 读取摘要均已写入脱敏证据。
- 证据文件均位于 Git 忽略的 `test-results/m3-e/`：`m3e-initial-20260828.json`、`m3e-live-inspect-20260828-r2.json`、`m3e-live-daily-initial-20260828.json`、`m3e-live-todo-disabled-20260828.json`、`m3e-http-negative-20260828.json`、`m3e-json-read-20260828.json`。
- 浏览器已验证公开首页、未登录 Daily / Todo 深链回登录页、合法日期回跳展示和外部回跳被丢弃；正式服务不含准备阶段的测试邮件读取器，当前没有可复用的已认证浏览器会话，因此认证后的私有 Home / Publication / Todo 页面未执行，未伪造 session。

## 3. 本分支新增框架

- `test/m3-e/run-live-mcp.js`：使用官方 MCP Client 通过真实 URL 执行现代 / legacy Discover、Context、Daily、Todo、正式读取和凭证切换探针；可选地执行 JSON API 同一 `clientRunId` 重放。
- `test/m3-e/record-schedule.js`：只验证并记录 `codex-standalone-cron` 创建的新任务 / 临时会话调度事件，不创建或模拟调度器。
- `test/m3-e/lib/safe-evidence.js`：统一执行私有文件权限、仓库外路径、敏感字段拒绝、PAT 脱敏、固定字段摘要和 Git 忽略证据写入。
- `test/m3-e-framework.test.js`：验证摘要不包含响应正文或凭证材料，私有文件权限和敏感 JSON 字段保护有效。

生成证据位于 Git 忽略的 `test-results/m3-e/`，报告和标准输出不包含 PAT、Authorization、Cookie、Session 凭证或用户正文；调度证据只保留受校验的 task/session 标识。

## 4. 真实环境执行矩阵

| 场景 | 当前状态 | 完成证据 |
| --- | --- | --- |
| PostgreSQL 15 Migration 与正式存储 | 首轮已执行，6/6 | Migration 摘要、真实 DB 计数与正式 revision、无明文凭证 |
| `@hono/node-server` 回环 HTTP 监听 | 首轮已执行 | 实际 TCP/HTTP 访问、Host/Origin/remoteAddress 负向边界 |
| 官方 MCP Client modern / legacy | 首轮通过 | 真实 HTTP 状态、六工具发现、Instructions 和工具调用摘要 |
| Daily / Todo 正式写入与读取 | Daily 首轮通过；Todo disabled 通过 | requestId、正式 revision、固定结果摘要 |
| JSON API / MCP 幂等一致性 | 首轮通过 | 同一 `clientRunId` 的单 revision 与重放结果 |
| PAT 撤销 / 轮换 | 通过 | 旧 PAT 被拒绝、新 PAT 成功；凭证不落盘到 Git/日志 |
| Tenant / Publication / inactive / Todo disabled 隐私 | 通过 | 跨目标失败关闭、disabled 不读 State 的脱敏结果 |
| 首轮立即运行 | 通过，正式 revision 1 | 首轮 Agent 运行与正式日报结果 |
| 第二次实际定时运行 | 通过，正式 revision 2 | `codex-standalone-cron` 创建独立新任务 / 会话，记录 scheduledAt、startedAt、requestId 与 revision |
| 修改要求后的下一次定时运行 | 通过，正式 revision 3 | 新需求 SHA-256、独立新任务 / 会话与变化后的正式结果 |
| 页面用户旅程 / 深链 | 通过 | 认证 Home / Publication / Todo、缺失日期、合法与外部 returnTo 的脱敏记录 |

## 5. 最终补充结果与安全清理

- 认证后的 Home、正式 Publication、缺失日期和 Todo disabled 页面旅程均通过；桌面 / 移动响应、深链回跳和私有缓存边界有脱敏证据。
- scheduled-repeat 与 changed-requirement 均由 `codex-standalone-cron` 到点创建独立新任务和会话，不使用人工 follow-up、固定 sleep 或模拟时钟；正式 Daily revision 依次为 2、3，同 key JSON API 重放没有增加 revision。
- 正式凭证切换验证通过：旧 PAT 被拒绝，replacement PAT 可由官方 MCP Client 完成六工具发现与 Daily Context 读取。
- 运行证据只保留 requestId、正式 revision、任务 / 会话标识和不可逆摘要；全量扫描未发现 PAT、Bearer、Cookie、OTP、邮箱、API key 或用户正文。
- 验收结束后已通过正式 logout 使浏览器 Session 失效，撤销 replacement PAT，并清理隔离 PostgreSQL、Node 服务与仓库外凭证目录；数据库 active credential 为 0，回环端口不再监听。

WorkBuddy、Hermes 和其他未执行客户端继续保持未验证；本验收只证明官方 MCP Client 的 modern / legacy 两时代、真实回环 HTTP、PostgreSQL 15、JSON API 交叉幂等和 Codex standalone cron 路径。

## 6. 完成判定

M3-E 对最终验收 head `3e3ee2e44126ce42db917760df7eafce39452cd2` 的独立验收通过；用户于 2026-08-28 确认 M3 完成。该结论不代表 `v1.0.0` 已合入 `main`、部署或发布，也不扩大到未执行的第三方客户端。
