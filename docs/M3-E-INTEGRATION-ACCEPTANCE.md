# M3-E 独立集成验收记录

状态：首轮真实本机试运行与非调度矩阵部分完成；认证后的私有页面和 standalone cron 调度运行仍待补齐。本报告不代表 M3-E 已通过。

## 1. 验收对象

- 独立分支：`test/v1-m3-integration`
- 精确基线：`origin/version/v1.0.0@734294e80efc349dd3a824ac0bcd9eed856743c2`
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

## 4. 待真实环境执行矩阵

| 场景 | 当前状态 | 完成证据 |
| --- | --- | --- |
| PostgreSQL 15 Migration 与正式存储 | 首轮已执行，6/6 | Migration 摘要、真实 DB 计数与正式 revision、无明文凭证 |
| `@hono/node-server` 回环 HTTP 监听 | 首轮已执行 | 实际 TCP/HTTP 访问、Host/Origin/remoteAddress 负向边界 |
| 官方 MCP Client modern / legacy | 首轮通过 | 真实 HTTP 状态、六工具发现、Instructions 和工具调用摘要 |
| Daily / Todo 正式写入与读取 | Daily 首轮通过；Todo disabled 通过 | requestId、正式 revision、固定结果摘要 |
| JSON API / MCP 幂等一致性 | 首轮通过 | 同一 `clientRunId` 的单 revision 与重放结果 |
| PAT 撤销 / 轮换 | 框架已就绪，待两份临时 PAT | 旧 PAT 被拒绝、新 PAT 成功；凭证不落盘到 Git/日志 |
| Tenant / Publication / inactive / Todo disabled 隐私 | Todo disabled 已通过真实 MCP/JSON API；私有页面待认证会话 | 跨目标失败关闭、disabled 不读 State 的脱敏结果 |
| 首轮立即运行 | Daily 首轮已通过；私有页面显示待认证会话 | 首轮 Agent 运行与正式日报结果 |
| 第二次实际定时运行 | 待 `codex-standalone-cron` | 新任务/临时会话标识、scheduledAt、startedAt、requestId、正式 revision；不能人工触发 |
| 修改要求后的下一次定时运行 | 待 `codex-standalone-cron` | 新需求 SHA-256、新任务/临时会话、下一次自动触发和变化后的正式结果 |
| 页面用户旅程 / 深链 | 公开页、未登录深链和回跳参数已通过；认证私有页待会话 | 脱敏页面记录、日期和合法 Todo 锚点保持 |

## 5. 当前环境阻断

本轮环境已由用户提供并完成只读核对；未执行清理脚本，未撤销当前 PAT，也未创建 standalone cron automation。真实 PostgreSQL、监听端点和私有 PAT 已用于首轮测试，但 PAT 内容未输出。

当前仍有两个边界未闭合：正式服务不提供准备阶段的测试邮件读取器且没有可复用浏览器会话，无法安全完成认证后的私有页面旅程；本轮按授权没有创建真实 standalone cron，因此第二次运行和修改要求后的下一次运行仍待独立新任务 / 临时会话触发。后续凭证必须继续通过受限本地文件或安全环境注入，不得放入任务消息、命令行、仓库或报告。

## 6. 完成判定

本报告和框架已完成 M3-E 首轮真实本机与非调度矩阵的可复查记录，但不构成最终通过。M3-E 仍需认证后的私有页面旅程、由 standalone cron 创建的新任务 / 临时会话完成首轮后的第二次定时运行及修改要求后的下一次运行，以及全部脱敏证据齐备后，才能形成最终通过结论。
