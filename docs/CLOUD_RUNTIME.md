# Cloud Runtime 开发说明

状态：`v1.0.0` M2-A / M2-B / M2-C / M2-D、M3-A / M3-B / M3-C 与 M3-D 研发能力，不代表云端产品已经发布或部署。

本文说明 Node.js / Hono 进程、PostgreSQL 连接、数据库 Migration、Space 身份与默认对象地基、日报 / Personal Todo / 主题 PostgreSQL 持久化、邮箱 OTP 与 Session、M3-A 的 Agent 配对和凭证生命周期、M3-B 的统一 Agent Request Layer 与 Content / Todo JSON API、M3-C 的公开与私有页面，以及 M3-D 的双时代远程 MCP。它不包含正式部署。Agent API、MCP 与假数据示例见 [`CLOUD_AGENT_ACCESS.md`](./CLOUD_AGENT_ACCESS.md)。

## 环境要求

- Node.js 22。
- PostgreSQL 15。
- 从仓库根目录运行命令。
- 真实配置由进程环境注入；程序不会自动读取 `.env` 文件。

先参考 [`.env.example`](../.env.example) 准备以下云端配置：

- `CLOUD_ORIGIN`：显式公开 Origin；非回环地址必须使用 HTTPS。回环 HTTP 只供本机开发，必须同时使用回环 `CLOUD_HOST`。
- `CLOUD_BASE_PATH`：可留空，或设置为无尾部斜杠的绝对路径。
- `CLOUD_HOST`：默认 `127.0.0.1`；回环 HTTP Origin 不得搭配 `0.0.0.0`、`::` 或其他公开监听地址。
- `CLOUD_PORT`：默认 `3000`。
- `DATABASE_URL`：独立 PostgreSQL 数据库连接地址。
- `PG_SSL_MODE`：`disable` 或 `require`。
- `PG_POOL_MAX`、`PG_IDLE_TIMEOUT_MS`、`PG_CONNECTION_TIMEOUT_MS`：连接池边界。
- `BETTER_AUTH_SECRET`、`IDENTITY_DIGEST_SECRET`：至少 32 字符的独立随机 Secret。
- `AGENT_TOKEN_DIGEST_SECRET`、`PAIRING_CODE_DIGEST_SECRET`：至少 32 字符、彼此独立且不得与身份 Secret 复用；分别用于长期凭证摘要和短时配对码派生 / 摘要。
- `AGENT_API_BASE_URL`、`AGENT_MCP_URL`：与 `CLOUD_ORIGIN` 和 `CLOUD_BASE_PATH` 严格一致的公开绝对地址；分别指向已实现的 JSON API 与 MCP 路由。
- `MAIL_MODE`：必须显式配置；本地与 CI 使用 `fake`，腾讯云投递使用 `ses`。缺失或空值时云端配置失败，不会降级到 Fake。
- `TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`、`TENCENT_SES_REGION`、`TENCENT_SES_FROM_EMAIL`、`TENCENT_SES_TEMPLATE_ID`、`TENCENT_SES_SUBJECT`：只在 `ses` 模式需要。

不要提交 `.env`、数据库密码、真实主机配置或用户数据。

`PG_SSL_MODE` 是 PostgreSQL TLS 的唯一配置来源。`DATABASE_URL` 不得携带 `sslmode`、`sslcert`、`sslkey`、`sslrootcert` 或其他 `ssl*` 查询参数；发现这类参数时进程会失败关闭，避免连接字符串覆盖显式 TLS 策略。

## 构建、Migration 与启动

```bash
npm ci
npm run build:cloud
npm run db:migrate
npm run start:cloud
```

`npm run db:migrate` 是唯一正式 Migration 入口。正常 `npm run start:cloud` 不会建立或修改数据库结构；空数据库必须先显式执行 Migration。

Migration Runner 先持有固定的 PostgreSQL 会话级 advisory lock，再在显式 Migration 命令内建立自身的 `app.schema_migrations` 元数据表。编号 SQL 按四位数字前缀顺序逐个执行，每个文件拥有独立事务；表中记录文件名、原始内容的 SHA-256 摘要和执行时间。重复运行会跳过已记录文件；摘要变化、数据库存在本地未知记录、历史不连续或仍有待执行文件时，结构兼容检查失败关闭。项目不提供自动 Down Migration。

当前 Migration 集合只追加以下结构：

- `0001_initialize_app_schema.sql`：初始化 `app` Schema 的版本入口。
- `0002_create_tenant_foundation.sql`：建立 `spaces`、`home_profiles`、`publications`、`publication_configs`、`theme_selections` 与 `todo_profiles`。
- `0003_create_domain_storage.sql`：建立日报 Candidate、提交结果、Issue、Compiled Edition、日期锁，Personal Todo 状态与提交结果，以及 Space 自定义主题定义和预览；同时为主题选择补充当前激活清单。它不建立 Better Auth 表。
- `0100_create_email_identity.sql`：建立 `auth` Schema 中 Better Auth 1.7.1 所需的 User、Account、Session、Verification 与数据库限流表，并建立 `app.login_*` 邮件发送预留、摘要限流和供应商双 ID 记录。`0100` 为并行 M2-D 保留的 Migration 段，避免与 M2-C 文件名冲突。
- `0101_create_agent_access.sql`：建立 Agent Pairing、摘要凭证、持久配对限流与最小脱敏审计表。数据库不保存配对码或 PAT 明文。
- `0102_create_agent_request_layer.sql`：扩展持久 PAT / IP 读写限流，建立跨进程 Space 写入租约，并为 Todo Submission 增加 JSON API / MCP 共用的 `client_run_id`；已有记录一次性生成稳定的 `legacy-<digest>` 键，之后协议幂等键与领域 `candidate_id` 保持独立。

`PostgresTenancyStore` 只接受服务端认证得到的用户 ID 来解析或幂等建立唯一 Space。初始化在单一事务中建立 Home、默认 Publication、Publication Config、Home 主题、Publication 继承选择和默认关闭的 Todo Profile；失败会整体回滚，后续调用可以安全重试。面向业务读取的 Repository 必须绑定已解析的 `TenantContext` 或 `PublicationContext`，不提供按任意 `space_id` 进行全表查询的入口。

M2-C 的 `PostgresDailyStorage`、`PostgresTodoStorage` 和 `PostgresThemeStorage` 同样只能由已解析的上下文创建。Daily Coordinator 以 `clientRunId` 和规范化内容摘要实现幂等，并通过 Publication 日期行锁串行化同一天的正式写入；Todo Coordinator 通过 Space 的 Todo Profile 行锁保护状态版本。Candidate、正式状态、编译结果和幂等回执在各自单一事务中提交，编译或最终持久化失败会整体回滚。主题系统 Revision 仍由只读文件 Reader 提供，Space 后续自定义 Revision、预览、选择与激活清单进入 PostgreSQL；同名 Space Revision 不会修改或覆盖系统 Revision。

Coordinator 只负责把 M1 Application Service 接到 PostgreSQL 事务边界和幂等摘要，不复制或改变 M1 的候选校验、编排、编译、Todo 冲突规则及主题语义；Theme Adapter 也通过依赖注入复用 M1 的 Active Manifest 生成函数。

M3-B 的 `/api/v1` 只接受活动 PAT。统一请求层从摘要凭证解析唯一 Space，再在该 Space 内二次解析 Publication；请求参数和 Candidate 不能指定或覆盖 `userId` / `spaceId`。读写分别执行持久 PAT / 受信 IP 限流，写入额外受每 Space 的短时跨进程租约限制。GET 不要求请求 `Content-Type`；POST 在完整 JSON 解析前执行 256 KiB 大小检查，并要求 `application/json` 与 `Idempotency-Key`。

Daily API 把历史日期与完整替换确认绑定到精确 Publication、日期和锁内正式 revision；未来日期、过期确认、停用 Publication 和跨 Space 目标均在正式写入前失败。Todo API 使用独立 `clientRunId` 作为协议幂等键，同时保留 Candidate `candidateId` 的领域唯一性。两条写入都继续通过 M1 Application Service，并在 PostgreSQL 事务中原子提交 Candidate、Submission、正式 State / Issue 与 Compiled Edition。

M3-C 的私有阅读服务只从 Session 解析出的 Space 进入 PostgreSQL Repository。Home、日报阅读页与 Todo 页不接受客户端指定 Space；主题必须同时具备有效 Home 选择与 Publication 选择，选择链不完整时页面失败关闭。正式日报在同一个 `REPEATABLE READ READ ONLY` 快照中取得 Issue 与 Compiled Edition，复用静态构建相同的 Compiled Edition 投影，并保持编译后的模块顺序与层级；指定日期不存在时返回明确 404，不回退到其他日期。首次还没有正式日报时，Home 只显示版本化的系统示例，不写入 Candidate、Issue 或 Compiled Edition；第一份正式日报生成后会在同一位置替换示例。

Personal Todo 仍默认关闭。设置页只读取开关与非归档数量，不展示任务标题；关闭时 `/todo/` 不读取保留的 State 正文，直接引导回设置。启用后，Todo 页面只读展示正式 State，并固定按已逾期、今天、接下来、暂无日期和今天已完成分组；浏览器不能直接修改任务。

M3-D 精确锁定 `@modelcontextprotocol/server@2.0.0`、`@modelcontextprotocol/client@2.0.0` 与 `zod@4.2.0`。`POST /mcp` 通过一个 `createMcpHandler` Server Factory 同时服务现代 `2026-07-28` 和无状态兼容 `2025-11-25`，不生成协议 Session，也不注册 GET / DELETE 流。六个工具共享 M3-B 的 `AgentRequestAuthenticator`、`AgentOperationsService`、PostgreSQL 事务、限流、写入租约和 `clientRunId` 幂等状态，不存在第二套 Token 或业务数据路径。

MCP 在解析前按独立的 256 KiB 上限读取请求克隆；原请求保留给官方 SDK。真实 Host、请求目标 Host、Socket 协议、回环 TLS 终止代理和可选浏览器 `Origin` 都必须与 `CLOUD_ORIGIN` 一致，连接元数据不可得时失败关闭。回环 HTTP Origin 还要求进程只绑定回环地址，并在运行时独立拒绝所有非回环连接来源；即使请求 Host 与 Origin 字面一致也不能绕过该边界。现代请求还必须携带 `MCP-Protocol-Version`；其版本、`Mcp-Method`、`Mcp-Name` 与正文一致性由官方 SDK 校验。PAT 在每个 POST 前重新认证并按实际工具区分读写额度；传入 SDK 的认证对象只含脱敏占位 Token 与内部请求上下文，不把原始 PAT 暴露给工具回调。

工具的严格 Zod 输入 / 输出 Schema 会由 SDK 转换为 JSON Schema；Context 返回默认目标、明确日期和写入边界，提交工具继续进入正式 Writer / Compiler。工具业务失败使用 `isError`、稳定 `error.code/message/requestId` 和脱敏短文本，协议错误由 SDK 返回 JSON-RPC 错误。Server Instructions 在前 512 字符内完整声明 Context-first、明确目标、Candidate 隔离、Todo disabled、幂等重试和用户确认规则。

M2-D 精确锁定 `better-auth@1.7.1` 与 `tencentcloud-sdk-nodejs-ses@4.1.271`，并以 `uuid@11.1.1` 覆盖腾讯云 SDK 的旧传递版本。Better Auth 使用 `auth` Search Path 和数据库 Session；Email OTP 固定为 6 位、5 分钟、最多错误 3 次、摘要保存、重发轮换。应用在调用邮件 Adapter 前，以 PostgreSQL 锁并发预留单邮箱冷却、邮箱小时、IP 小时和全站每日硬上限；所有状态改变型认证请求还必须通过严格的同源 Origin 校验。

`MAIL_MODE=fake` 不调用外部供应商。Fake OTP 读取能力只由自动化测试在构造测试 App 时显式注入；正式 `npm run start:cloud` 即使运行在 Fake 模式也不会注册测试读取路由。`MAIL_MODE=ses` 使用腾讯云 SES `SendEmail` 触发类模板；成功必须同时保存 RequestId 和 MessageId，拒绝、超时或缺失任一 ID 时返回脱敏 `503`，同一次请求不自动重试。

M3-A 将 PAT 字符格式锁定为 `dnpat_<22 字符 selector>_<43 字符 secret>`：selector 为 128 bit 随机公开定位段，secret 为 256 bit 随机值。服务端只保存带部署 Secret 的 HMAC-SHA-256 摘要与掩码 hint。配对码为 10 位无歧义字符、默认 10 分钟有效，由 Pairing ID 与单调代次派生；数据库只保存摘要，刷新增加代次并立即使旧码失效。Claim 只签发一次默认 10 分钟的 provisioning PAT；完成最小只读 Verify 后同一凭证原子变为 active，超时、取消、轮换或撤销后不能恢复。

`config/cloud.json` 的 `agentAccess` 同时固定 Pairing / provisioning TTL、Claim / Verify 每 IP 小时上限、16 KiB 浏览器设置与 Claim 请求体上限、24 小时限流事件保留期与 90 天最小审计保留期。浏览器设置与 Claim 请求体在 JSON 或表单解析前按流读取并停止超限请求，具体数值不散落在 Controller 中。Verify 是 PAT-only 的空 POST，不要求也不解析 `Content-Type` 或请求体。

待配对、provisioning 与 active 共同占用每 Space 10 个授权槽位。所有 Agent 授权生命周期事务统一按 `Space → Pairing → Credential` 获取有关行锁；只涉及其中一类子资源时仍先锁 Space，不能建立反向锁序。轮换在同一事务中撤销旧凭证并建立替代凭证，不增加槽位。浏览器创建和轮换使用 operation ID，重复提交不会重放明文；相同 operation ID 携带不同请求会冲突。

云端编译产物位于 `.cloud-dist/`，已被 Git 忽略，不进入现有静态 `dist/` 或 `local-dist/`。现有本地文件版仍使用 `npm start`，行为不变。

健康检查路径相对于 `CLOUD_BASE_PATH`：

- `GET /health/live` 只证明 Node.js 进程存活，不访问数据库。
- `GET /health/ready` 检查 PostgreSQL 连接与 Migration 摘要集合；不可用时只返回通用 `503`。
- `GET /` 是不含用户数据的公开产品入口；已登录用户只会看到进入私人编辑部的动作。
- `GET /login` 显示统一品牌外壳中的邮箱与 OTP 登录页；成功后由 `GET /post-login` 把首次用户送到接入页，已有用户送回安全的站内目标或 Home。
- `ALL /api/auth/*` 由 Better Auth 处理 Email OTP、Session 与退出。
- `GET /onboarding` 显示完整接入话术与独立的短时配对码；接入话术本身不包含配对码、PAT、MCP 配置或完整调度提示词。`GET /.well-known/dailynews-agent-setup.json` 是无用户数据的公开接入说明。
- `GET /home` 显示系统示例或最新正式日报；正式内容出现后不再并列显示示例，也不伪造调度、在线或更新时间承诺。
- `GET /p/:publicationId/?date=YYYY-MM-DD` 按 Compiled Edition 的正式层级和顺序阅读指定日期日报；省略日期时读取该 Publication 的最新正式日报。
- `GET /todo/` 只在 Todo 已启用时展示正式 State；`GET /settings` 管理站点事实、Todo 开关、Agent 授权入口与账户安全。
- `GET /settings/agent` 与其连接 / 高级凭证子路由使用 Session、严格同源检查和绑定当前 Session 的 CSRF Token；浏览器使用 HTML 页面，声明 JSON 的客户端仍获得 M3-A 契约。完整 PAT 仅在创建或轮换成功响应中显示一次。
- `GET /settings/agent/openapi.yaml` 需要有效 Session，供高级接入下载当前 OpenAPI 契约。
- `POST /agent-pairing/v1/claim` 只接受短时配对码，一次返回 provisioning PAT；`POST /agent-pairing/v1/verify` 是无请求体的 PAT-only POST，只接受 `Authorization: Bearer <provisioning PAT>`，并返回不含正文的默认 Publication、时区与 Todo enabled 最小上下文。
- `GET /api/v1/publications`、`GET /api/v1/publications/:id/daily-context`、`POST /api/v1/publications/:id/daily-candidates` 与 `GET /api/v1/publications/:id/issues/:date` 提供 Content 正式读写闭环。
- `GET /api/v1/todo` 与 `POST /api/v1/todo/candidates` 提供 Todo 状态、正式 State 与受控写入；Todo 关闭时不读取保留正文。
- `POST /mcp` 提供六个 Daily / Todo MCP 工具；只接受 Bearer PAT 与 `application/json`。`GET /mcp`、`DELETE /mcp` 和其他方法固定返回 `405 Allow: POST`。

所有私有页面禁止公共缓存与索引。普通响应和日志不返回 Cookie、Session Token、OTP、完整邮箱、SQL、堆栈或供应商响应正文。HTTPS 在 Nginx 终止时，Nginx 必须通过回环地址访问 Node.js，保留公开 `Host`，并覆盖 `X-Forwarded-Proto $scheme` 与 `X-DailyNews-Client-IP`；应用独立核对实际 `Host`、HTTP 请求目标中的 Host、Socket 实际传输协议与 `CLOUD_ORIGIN`，只在两个 Host 都严格一致、直接上游地址为回环且 `X-Forwarded-Proto` 是单一匹配协议时使用代理协议参与同源判断。连接或 Socket 元数据不可得时直接视为不可信；来自非回环地址、缺失或多值的代理协议、absolute-form 请求目标与 `Host` 不一致、Host 不匹配及浏览器 `Origin` 不匹配都会继续拒绝，不能用任意 Origin 或伪造请求目标绕过 CSRF。

## 测试

```bash
npm test
npm run test:cloud
TEST_DATABASE_URL=postgresql://.../dailynews_test npm run test:cloud:integration
npm run build
npm run build:cloud
```

PostgreSQL 集成测试会删除并重建 `app` Schema，因此 `TEST_DATABASE_URL` 必须指向专用、可丢弃且库名包含 `test` 或 `ci` 的数据库。不得指向认证探针、用户测试库或未来生产数据库。

M2-B 集成测试额外覆盖并发首次初始化、事务故障回滚、部分初始化补偿、两用户隔离、Publication 归属和 Todo Space 隔离。M2-C 集成测试覆盖文件/PostgreSQL 等价、Daily/Todo 幂等冲突与并发锁、编译及最终写入故障回滚、主题预览/激活，以及三类领域数据的租户隔离。

M2-D 自动化只使用 Fake Adapter 或注入的 SES Stub，覆盖完整 OTP 登录、错误次数、重发轮换、一次性与并发消费、Session 跨新运行时保持、退出、初始化补偿、持久限流、全站并发硬上限、跨站首登拒绝、供应商失败脱敏、Cookie 属性和 Fake 测试路由隔离。真实 SES 不进入本地自检或 CI；只有用户另行授权后才能执行一次正式代码真实邮箱冒烟。

M3-A 集成测试覆盖 Bootstrap Pairing、刷新旧码失效、Claim / 无请求体 Verify 一次性、provisioning 超时、摘要存储、CSRF / 跨 Origin、浏览器重复提交、轮换与单独撤销、跨 Space 目标、第 11 个并发授权失败、持久 IP 限流，以及 Claim / 页面 Bootstrap、Verify / 取消之间的真实 PostgreSQL 锁顺序。云端单元测试通过真实 HTTP Adapter 覆盖回环 TLS 终止代理的同源判断及其负向边界。测试只使用虚构用户和临时凭证，不把明文写入数据库、日志或测试快照。

M3-B 集成测试覆盖活动 / 撤销 PAT、`last_used_at` 节流触达、PAT 与 IP 持久限流、跨进程写入租约、Content 正式写入与读取、跨 Space 隐藏、未来 / 历史 / `replace` 锁内确认、停用 Publication、Todo disabled 最小披露、Todo `clientRunId` 幂等与 Candidate ID 独立性，以及 `0102` 对短 legacy Candidate ID 的安全升级。OpenAPI 测试从真实路由清单核对全部 Method / Path、Bearer、POST 幂等头、错误码与假数据示例。

M3-C 集成测试覆盖公开入口、首次登录去向、接入话术与配对码分离、系统示例不落库、第一份正式日报替换示例、Compiled Edition 顺序和层级、指定日期 404、Todo 浏览器启停、正式 State 五组投影、关闭后不披露保留正文、主题选择链不完整时失败关闭，以及动态 Agent 名称的 HTML 转义。云端单元测试同时验证可见页面使用统一品牌外壳、资源入口和无用户数据的公开边界。

M3-D 协议自动化使用官方 `@modelcontextprotocol/client@2.0.0` 分别执行现代 Discover 和兼容 Initialize，核对同一组六个工具的 `tools/list`、全部 `tools/call`、Instructions、Schema、Annotations、结构化错误、无 Session 与私有响应头。负向测试覆盖 Method、Content-Type、流式超限、Cookie / PAT 混淆、跨 Origin、现代协议版本与方法 / 工具名 Header 错配，以及真实 Node HTTP Adapter 下的 Host、absolute-form 请求目标、回环 TLS 终止和无 Socket 失败关闭。PostgreSQL 集成测试使用同一 PAT 跨 MCP / JSON API 复用相同 Daily `clientRunId`，核对只产生一个正式 revision，并验证轮换后旧 Token 失败、新 Token 同时恢复两种协议。Inspector 基线与客户端配置见 [`CLOUD_AGENT_ACCESS.md`](./CLOUD_AGENT_ACCESS.md)。
