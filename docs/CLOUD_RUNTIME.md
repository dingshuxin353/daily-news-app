# Cloud Runtime 开发说明

状态：`v1.0.0` M2-A / M2-B / M2-C 研发能力，不代表云端产品已经发布或部署。

本文说明 Node.js / Hono 进程、PostgreSQL 连接、数据库 Migration、M2-B 的 Space 身份与默认对象地基，以及 M2-C 的日报、Personal Todo、主题 PostgreSQL 持久化。它不包含 Better Auth、登录、Session、JSON API 或 MCP。

## 环境要求

- Node.js 22。
- PostgreSQL 15。
- 从仓库根目录运行命令。
- 真实配置由进程环境注入；程序不会自动读取 `.env` 文件。

先参考 [`.env.example`](../.env.example) 准备以下云端配置：

- `CLOUD_ORIGIN`：显式公开 Origin；非回环地址必须使用 HTTPS。
- `CLOUD_BASE_PATH`：可留空，或设置为无尾部斜杠的绝对路径。
- `CLOUD_HOST`：默认 `127.0.0.1`。
- `CLOUD_PORT`：默认 `3000`。
- `DATABASE_URL`：独立 PostgreSQL 数据库连接地址。
- `PG_SSL_MODE`：`disable` 或 `require`。
- `PG_POOL_MAX`、`PG_IDLE_TIMEOUT_MS`、`PG_CONNECTION_TIMEOUT_MS`：连接池边界。

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

`PostgresTenancyStore` 只接受服务端认证得到的用户 ID 来解析或幂等建立唯一 Space。初始化在单一事务中建立 Home、默认 Publication、Publication Config、Home 主题、Publication 继承选择和默认关闭的 Todo Profile；失败会整体回滚，后续调用可以安全重试。面向业务读取的 Repository 必须绑定已解析的 `TenantContext` 或 `PublicationContext`，不提供按任意 `space_id` 进行全表查询的入口。

M2-C 的 `PostgresDailyStorage`、`PostgresTodoStorage` 和 `PostgresThemeStorage` 同样只能由已解析的上下文创建。Daily Coordinator 以 `clientRunId` 和规范化内容摘要实现幂等，并通过 Publication 日期行锁串行化同一天的正式写入；Todo Coordinator 通过 Space 的 Todo Profile 行锁保护状态版本。Candidate、正式状态、编译结果和幂等回执在各自单一事务中提交，编译或最终持久化失败会整体回滚。主题系统 Revision 仍由只读文件 Reader 提供，Space 后续自定义 Revision、预览、选择与激活清单进入 PostgreSQL；同名 Space Revision 不会修改或覆盖系统 Revision。

Coordinator 只负责把 M1 Application Service 接到 PostgreSQL 事务边界和幂等摘要，不复制或改变 M1 的候选校验、编排、编译、Todo 冲突规则及主题语义；Theme Adapter 也通过依赖注入复用 M1 的 Active Manifest 生成函数。云端 HTTP/API 接入仍属于后续任务。

云端编译产物位于 `.cloud-dist/`，已被 Git 忽略，不进入现有静态 `dist/` 或 `local-dist/`。现有本地文件版仍使用 `npm start`，行为不变。

健康检查路径相对于 `CLOUD_BASE_PATH`：

- `GET /health/live` 只证明 Node.js 进程存活，不访问数据库。
- `GET /health/ready` 检查 PostgreSQL 连接与 Migration 摘要集合；不可用时只返回通用 `503`。

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
