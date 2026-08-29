# M4-E 完整独立集成验收报告

状态：**独立验收通过，无阻断；等待用户确认 M4 里程碑完成**

本报告只记录 M4-E 对当前 M4 版本线的最终独立验收，不代表用户已经确认合入、发布或开始 M5。

## 1. 精确对象与版本边界

- 验收 worktree：`/Users/gouzi/dingshuxinRepo/daily-news-workspace-private/worktrees/test-v1-m4-integration`
- 分支：`test/v1-m4-integration`
- 应用验收基线：`origin/version/v1.0.0@215e2c576023120201ad85786b9e7b0e3e6b3cb1`
- 应用验收 head：`63c4fa7a93a41b4e9f74aec14fc9a51879e338d4`
- Draft PR：[#30](https://github.com/dingshuxin353/daily-news-app/pull/30)
- 对应 CI：`33240677849`；精确 head 的 Test and build 全部成功
- 验收 head 相对基线只包含既有运行文档的两处修改：`docs/CLOUD_RUNTIME.md`、`docs/M3-E-INTEGRATION-ACCEPTANCE.md`；`src/` 差异为 0

本次报告文件是验收完成后追加的测试交付物；它不改变上述应用验收对象，也不把测试分支当作应用功能分支。

## 2. 执行环境与安全边界

本轮建立了隔离、临时、仅回环可达的真实运行环境：

- Homebrew PostgreSQL `15.19` 临时实例，空库执行正式 Migration `8/8`，并使用真实 PostgreSQL 适配器。
- 真实 `@hono/node-server`、正式 `startCloudServer`、正式 Origin/Host resolver，通过真实 TCP/HTTP 回环端口访问；MCP 没有改写为 `app.request`。
- 用户、邮箱、日报、Todo、主题和连接均为本轮虚构验收数据；邮件使用 fake adapter，不触达真实邮件服务。
- PAT、浏览器 Cookie 和临时输入只在仓库外受限文件中使用，文件权限为 `0600`，目录为 `0700`；没有进入 Git、命令输出、日志、截图或本报告。
- 验收结束前已通过正式能力撤销旧/新 PAT、退出测试 Session，停止服务和数据库，并删除本轮临时目录。运行证据只保留在 Git 忽略的 `test-results/m4-e/`，全部文件为 `0600`。

脱敏扫描覆盖运行证据和报告，未发现 PAT 值、Cookie/Session 值、OTP、邮箱地址或真实用户数据。截图仅包含固定虚构内容。

## 3. 自动化、CI 与精确运行证据

| 检查 | 结果 |
| --- | --- |
| `npm test` | 126/126 通过 |
| `npm run test:cloud` | 44/44 通过 |
| 隔离 PostgreSQL 15.19：`npm run test:cloud:integration` | 59/59 通过 |
| `npm run build` / `npm run build:cloud` | 通过 |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `git diff --check` | 通过 |
| CI `33240677849` | Run tests、Cloud runtime、PostgreSQL 15、静态构建、云端构建全部成功 |

Git 忽略目录中的脱敏证据包括：

- `test-results/m4-e/m4e-http-initial-20260829.json`
- `test-results/m4-e/m4e-http-journeys-20260829.json`
- `test-results/m4-e/m4e-live-mcp-initial-20260829.json`
- `test-results/m4-e/m4e-theme-propagation-20260829.json`
- `test-results/m4-e/m4e-theme-delete-history-20260829.json`
- `test-results/m4-e/m4e-publication-lifecycle-20260829.json`
- `test-results/m4-e/m4e-todo-lifecycle-20260829.json`
- `test-results/m4-e/m4e-negative-boundaries-20260829.json`
- `test-results/m4-e/m4e-route-contracts-20260829.json`
- `test-results/m4-e/m4e-credential-cutover-20260829.json`
- `test-results/m4-e/m4e-session-invalidation-20260829.json`
- `test-results/m4-e/m4e-database-snapshot-20260829.json`
- `test-results/m4-e/m4e-browser-visual-20260829.json`
- `test-results/m4-e/m4e-browser-interaction-20260829.json`

## 4. M4-E 端到端验收矩阵

### 4.1 用户、示例与多日报

- 既有 M4-A–D 的 PostgreSQL 集成覆盖了新用户 OTP、显式昵称、昵称完成后建立 Bootstrap Pairing、首次登录私有 Shell 和昵称不得从邮箱猜测；本轮使用 fake mail 创建隔离用户，并通过真实 HTTP Session 访问正式页面。
- 首次无正式数据时，真实 `/home` 显示版本化系统示例；示例没有 Candidate、Issue、Compiled、Agent 在线或调度状态。
- 通过真实 MCP 写入第一份 Daily 后，正式 Issue/Compiled revision 为 `1`，Home 同一主卡替换为正式内容；页面不显示 Candidate 或 Token 文案。
- 通过浏览器 Session 创建第二份 Publication，既有 Agent 的设置话术为普通语言且不含配对码；第二份日报独立写入并出现在 Home 的紧凑入口。
- 通过真实设置表单改变排序后，第二份 Publication 成为派生首要项；Home 主内容和 Agent 默认 `get_daily_context` 目标同步变化。恢复排序后再次确认唯一首要项和活动排序事实。

### 4.2 Publication 生命周期、阅读与隔离

- 同 Space 的第二份日报可创建、配置、独立读取和独立写入；已有正式内容在停用后仍从原地址可读，页面显示只读归档语义。
- 停用 Publication 后，真实 MCP 新写入得到结构化 `publication_inactive`，Issue revision 保持不变；恢复后追加到活动列表末尾。
- 先停用一个日报、再尝试停用最后一个活动日报得到 `409`，最后活动项保护成立；随后恢复并复原排序。
- 已有正式日期读取成功；未来/不存在日期明确 `404` 且不回退到其他日期；不存在或不属于当前 Space 的 Publication 统一 `404`，不触达目标正文。
- 真实 HTTP 页面验证 Home、`/publications/`、指定 Publication 页面、停用归档页和设置入口均使用当前 Session 的 Space；PostgreSQL 集成继续覆盖跨 Space 目标隐藏和不越权读取。

### 4.3 Theme current revision、继承和删除

- 官方主题通过真实 MCP/JSON API 可读，官方主题不可写；Theme Context 返回官方目录、约束和使用关系。
- 自定义主题真实创建为 revision `1`，更新到 revision `2`，再通过真实 MCP 更新到 revision `3`。Home、Publication `inherit` 和显式 `override` 页面均实际加载同一 current revision 的主题资源。
- 自定义主题被 Home/Publication 使用时，真实 `delete_theme` 返回结构化 `theme_in_use`，revision 不前进；失败不改变 current。
- 解除 Home/Publication 使用后，删除成功并从当前目录隐藏；删除后的历史 revision `1`、`2` 仍可读取。JSON API 读取已删除当前项返回脱敏 `target_not_found`。
- M4-A–D 的集成测试和本轮真实页面共同核对官方 ID 优先、继承/覆盖、删除状态不进入当前目录、历史定义保留以及主题选择失败关闭。

### 4.4 Todo 独立状态与隐私

- Todo 初始 disabled：`/todo/` 重定向到设置引导，Home 不显示 Todo 导航或正文，MCP Context 返回 `enabled:false`。
- 通过真实设置页面启用后，首条 Todo 经真实 MCP 写入正式 State revision `1`，Todo 页面和 Home 摘要出现；同一 `clientRunId` 经 JSON API 重放得到相同 revision。
- 关闭 Todo 后，页面和 Home 导航隐藏，MCP 读取 State 与写入均返回 `todo_disabled`；设置页只显示正式数据存在/计数，不显示任务正文。
- 再次启用后正式 State revision `1` 和任务投影恢复，关闭操作没有删除 State。PostgreSQL fake-pool/真实集成还验证 disabled 分支不会查询 `todo_states` 或 `state_payload`。

### 4.5 Agent、双传输、幂等与失败关闭

- 官方 `@modelcontextprotocol/client@2.0.0` 通过真实 TCP/HTTP 完成 modern `2026-07-28` 与 legacy `2025-11-25` Discover/Initialize；两者均为无状态，无 `Mcp-Session-Id`，无 CORS，响应使用 private/no-store 和 `X-Request-Id`。
- 两个协议均发现精确 11 个工具，Instructions、严格 Schema、输出结构和工具 annotations 与当前文档一致；Daily、Todo、Theme 共用同一 Agent Request Layer、Operations Service、PostgreSQL 事务和限流边界。
- Daily 与 Todo 写入均按各自的 `clientRunId` 幂等域工作；Theme 创建/更新/删除通过 `theme_operation_runs` 跨 JSON API/MCP 共享幂等事实。相同请求重放保持 revision，不同正文得到 `idempotency_conflict`。
- Theme 过期 `baseRevision` 得到 `revision_conflict`；Theme ID 与定义 ID 不一致、非法 CSS/定义字段得到 `schema_invalid`；业务错误均返回脱敏 message 和 requestId，失败不推进 current。
- 轮换 PAT 后旧 PAT 在 JSON API/MCP 均立即 `401`，新 PAT 可发现全部 11 个工具；随后撤销新 PAT，旧/新两枚均 `401`。浏览器 Cookie 不能替代 PAT。
- MCP `GET`、错误 Origin、错误 Host、错误 Content-Type、超大请求体、absolute-form/Host 不一致均失败关闭；浏览器写入的错误 Origin/Host 均被拒绝，正常 Session 状态未被改变。回环 HTTP 的非回环来源边界、TLS 终止、无 Socket 和真实 Node Adapter 回归已在前序 M3-D/M3-E 与当前 CI 测试覆盖。
- MCP Schema 入口由官方 SDK 在进入业务 handler 前拒绝不合规参数，表现为协议层错误；能够进入业务层的非法、过期、占用和幂等冲突均使用稳定业务错误结构。这一区分符合当前“官方 SDK 协议错误、应用业务错误”边界。

### 4.6 Migration、原子性与 M3 回归

- 隔离空库从 0 执行 8 个正式 Migration，并重复执行无副作用；精确 M2/M3 Schema、保留事实升级到 M4 Domain/Theme contract；失败 Migration 回滚并停止后续文件；已应用 checksum、pending migration 和并发 runner 检查均通过。
- M4-A–D PostgreSQL 集成覆盖 Publication 名称/地址唯一、8 份总上限、并发创建、排序与状态原子性、主题 revision/使用关系、昵称与 auth name 同事务、依赖写入故障回滚和 Todo 隐私。
- M3 Daily/Todo/PAT/MCP、内容正式写入、停用日报、Session/CSRF/Origin、跨租户、文件模式和公开 Todo 隔离回归全部通过；本轮真实数据库最终快照为 2 个活动 Publication、2 个正式 Issue/Compiled、1 个正式 Todo State、3 个自定义主题历史 revision（当前已软删除）、0 个活动凭证。

### 4.7 浏览器、无 JavaScript、可访问性与响应式

- 使用精确应用版本生成的脱敏 SSR 页面在真实浏览器中检查 Home、我的日报、日报阅读、Todo、日报站点、新建/配置、主题库、账户共 8 页 × `320/375/414/768/1280px`，共 40 组：无横向溢出、单一主内容和单一页面标题；移动控件实测最低 44px。
- 移动端使用同序选择器导航，桌面使用目录/正文布局；键盘 Tab 后焦点可见。共享来源 Dialog 打开后焦点进入关闭按钮，关闭后焦点归还触发按钮。
- 多来源页面保留无 JavaScript 的来源清单；远端图片带尺寸、alt、`referrerpolicy=no-referrer`，真实失败时显示文字回退；长动态字段沿用 HTML 转义和可换行布局。
- 真实 HTTP 页面响应包含 CSP、`no-store`、Referrer-Policy、nosniff/X-Frame-Options 等私有边界；静态/云端构建和 M4-D 的四主题视觉回归继续通过。浏览器视觉代理只用于把已由真实 Session 取得的 SSR 输出送入浏览器，代理对 CSRF 和邮箱做脱敏，不把它当作认证事实来源。

## 5. 未验证项与剩余风险

以下项目不构成 M4-E 阻断，但必须保留在交付边界内：

1. 本轮没有使用真实公网 HTTPS、反向代理、正式域名、CD 或生产服务器；这些属于 M5 的测试部署/邀请测试与后续生产准备边界。
2. 本轮使用 fake mail adapter，没有发送真实 OTP；真实 SES 配置和供应商故障需要在部署环境单独验证。
3. 本轮使用官方 MCP TypeScript Client，未把 WorkBuddy、Hermes 或其他第三方客户端的兼容性表述为已验证；MCP Inspector 的历史严格 Schema 基线仍只能作为补充证据。
4. 没有等待 Session 自然过期；本轮通过正式 sign-out 验证服务端 Session 立即失效，并由自动化覆盖过期/撤销相关边界。生产时长配置仍需在 M5 运行环境确认。
5. M4 不新增服务端 Agent 调度器；本报告不把一次性脚本、人工 follow-up 或本地测试代理当作调度证据。M3-E 的 standalone cron 证据按其原验收边界保留，不扩大为 M4 服务能力。

## 6. 最终结论与交接

在精确应用 head `63c4fa7a93a41b4e9f74aec14fc9a51879e338d4` 上，M4-E 第 11、12 节要求的真实 PostgreSQL、真实回环 HTTP/MCP、双传输、页面旅程、主题/Todo/Publication 生命周期、幂等、租户/凭证/请求边界、Migration、M3 回归和视觉收窄检查均已完成，未发现阻断问题。

**结论：M4-E 独立验收通过，可将本报告提交交给 Git 管理 Agent；M4 仍等待维护者最终确认后再标记完成、归档计划或进行版本线后续操作。**

本报告提交后应再次确认：worktree 干净、报告 head 的 CI 全绿、`src/` 相对应用基线仍为 0；未获得用户确认前不得合并 PR、修改 main/version 标签、部署或开始 M5。
