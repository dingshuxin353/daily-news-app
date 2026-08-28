# M3-E 独立集成验收记录

状态：准备阶段完成，真实环境验收待执行；本报告不代表 M3 已通过。

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
| 本机 PostgreSQL 集成 | 未运行 | 本机没有 `TEST_DATABASE_URL`；测试按安全约束拒绝启动，未伪造结果 |

现有 MCP 自动化使用官方 SDK，但其中的集成 transport 通过本地 `app.request` 或测试 App；它们是代码契约和协议回归证据，不替代真实监听端点上的外部客户端证据。

## 3. 本分支新增框架

- `test/m3-e/run-live-mcp.js`：使用官方 MCP Client 通过真实 URL 执行现代 / legacy Discover、Context、Daily、Todo、正式读取和凭证切换探针；可选地执行 JSON API 同一 `clientRunId` 重放。
- `test/m3-e/record-schedule.js`：只验证并记录 `codex-standalone-cron` 创建的新任务 / 临时会话调度事件，不创建或模拟调度器。
- `test/m3-e/lib/safe-evidence.js`：统一执行私有文件权限、仓库外路径、敏感字段拒绝、PAT 脱敏、固定字段摘要和 Git 忽略证据写入。
- `test/m3-e-framework.test.js`：验证摘要不包含响应正文或凭证材料，私有文件权限和敏感 JSON 字段保护有效。

生成证据位于 Git 忽略的 `test-results/m3-e/`，报告和标准输出不包含 PAT、Authorization、Cookie、Session 凭证或用户正文；调度证据只保留受校验的 task/session 标识。

## 4. 待真实环境执行矩阵

| 场景 | 当前状态 | 完成证据 |
| --- | --- | --- |
| PostgreSQL 15 Migration 与正式存储 | 待用户安装并提供专用连接 | Migration 摘要、真实 DB 结果、无明文凭证 |
| `@hono/node-server` 回环 HTTP 监听 | 待执行 | 实际 socket 访问、Host/Origin/remoteAddress 边界 |
| 官方 MCP Client modern / legacy | 框架已就绪，待真实端点 | 真实 HTTP 状态、六工具发现和工具调用摘要 |
| Daily / Todo 正式写入与读取 | 框架已就绪，待真实 PAT | requestId、正式 revision、固定结果摘要 |
| JSON API / MCP 幂等一致性 | 框架已就绪，待 JSON API URL | 同一 `clientRunId` 的单 revision 与重放结果 |
| PAT 撤销 / 轮换 | 框架已就绪，待两份临时 PAT | 旧 PAT 被拒绝、新 PAT 成功；凭证不落盘到 Git/日志 |
| Tenant / Publication / inactive / Todo disabled 隐私 | 既有 CI 已覆盖代码事实；真实端点待复核 | 跨目标失败关闭、disabled 不读 State 的脱敏结果 |
| 首轮立即运行 | 待真实 Agent | 首轮 Agent 运行与正式日报结果 |
| 第二次实际定时运行 | 待 `codex-standalone-cron` | 新任务/临时会话标识、scheduledAt、startedAt、requestId、正式 revision；不能人工触发 |
| 修改要求后的下一次定时运行 | 待 `codex-standalone-cron` | 新需求 SHA-256、新任务/临时会话、下一次自动触发和变化后的正式结果 |
| 页面用户旅程 / 深链 | 既有应用测试已覆盖代码合同；真实浏览器旅程待执行 | 脱敏截图/记录、日期和合法 Todo 锚点保持 |

## 5. 当前环境阻断

按本轮授权，尚未安装或启动软件，尚未创建数据库、账号、PAT 或 standalone cron automation。当前没有可用的 `TEST_DATABASE_URL`、真实 `M3E_MCP_URL` 或私有 PAT 文件，因此不能把本地自动化、占位 URL 或历史资料表述为真实外部闭环。

用户安装 PostgreSQL 15 并由研发任务提供可控的隔离运行输入后，再按 `test/m3-e/README.md` 执行真实环境收窄验收。凭证必须通过受限本地文件或安全环境注入，不得放入任务消息、命令行、仓库或报告。

## 6. 完成判定

本报告和框架只完成 M3-E 的可复查准备工作。M3-E 仍需真实 MCP 客户端闭环、由 standalone cron 创建的新任务 / 临时会话完成首轮后的第二次定时运行及修改要求后的下一次运行，以及 PostgreSQL 真实结果和脱敏证据全部齐备后，才能形成最终通过结论。
