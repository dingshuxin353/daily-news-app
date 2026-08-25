# Cloud Runtime 开发说明

状态：`v1.0.0` M2-A 研发能力，不代表云端产品已经发布或部署。

本文只说明 Node.js / Hono 进程、PostgreSQL 连接和数据库 Migration。它不包含登录、用户、Space、日报、Todo、主题业务表、JSON API 或 MCP。

## 环境要求

- Node.js 22。
- PostgreSQL 15。
- 从仓库根目录运行命令。
- 真实配置由进程环境注入；程序不会自动读取 `.env` 文件。

先参考 [`.env.example`](../.env.example) 准备以下 M2-A 配置：

- `CLOUD_ORIGIN`：显式公开 Origin；非回环地址必须使用 HTTPS。
- `CLOUD_BASE_PATH`：可留空，或设置为无尾部斜杠的绝对路径。
- `CLOUD_HOST`：默认 `127.0.0.1`。
- `CLOUD_PORT`：默认 `3000`。
- `DATABASE_URL`：独立 PostgreSQL 数据库连接地址。
- `PG_SSL_MODE`：`disable` 或 `require`。
- `PG_POOL_MAX`、`PG_IDLE_TIMEOUT_MS`、`PG_CONNECTION_TIMEOUT_MS`：连接池边界。

不要提交 `.env`、数据库密码、真实主机配置或用户数据。

## 构建、Migration 与启动

```bash
npm ci
npm run build:cloud
npm run db:migrate
npm run start:cloud
```

`npm run db:migrate` 是唯一正式 Migration 入口。正常 `npm run start:cloud` 不会建立或修改数据库结构；空数据库必须先显式执行 Migration。

Migration Runner 先持有固定的 PostgreSQL 会话级 advisory lock，再在显式 Migration 命令内建立自身的 `app.schema_migrations` 元数据表。编号 SQL 按四位数字前缀顺序逐个执行，每个文件拥有独立事务；表中记录文件名、原始内容的 SHA-256 摘要和执行时间。重复运行会跳过已记录文件；摘要变化、数据库存在本地未知记录、历史不连续或仍有待执行文件时，结构兼容检查失败关闭。项目不提供自动 Down Migration。

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
