# Contributing to DailyNews

感谢你参与 DailyNews。这个仓库的 `main` 始终代表已经发布或随时可以发布的稳定版本；较大的目标版本在临时 `version/vX.Y.Z` 分支中集成。

## 开始前

- 使用 Node.js 22。
- 先确认任务应基于哪个分支：已发布版本修复基于 `main`，当前版本开发基于对应的 `version/vX.Y.Z`。
- 一个分支只处理一个可验收目标，不混入无关重构或格式化。
- 不提交真实 Token、邮箱凭证、`.env`、测试账号或用户日报。

## 分支命名

使用小写英文和连字符：

```text
feat/<short-description>
fix/<short-description>
test/<short-description>
docs/<short-description>
ci/<short-description>
hotfix/<short-description>
```

`hotfix/*` 只用于已发布版本的紧急修复，并从 `main` 创建。不要创建永久 `develop`、`staging` 或 `production` 分支。

## 提交信息

使用：

```text
type(scope): summary
```

常用类型包括 `feat`、`fix`、`refactor`、`test`、`docs`、`ci`、`build`、`chore`、`perf` 和 `revert`。

示例：

```text
feat(mcp): add candidate submission tool
fix(auth): reject revoked agent token
test(tenant): cover cross-space access
```

`type` 和 `scope` 使用小写英文；摘要可以使用中文或英文，同一个 Pull Request 内保持一致。最终提交不能使用 `WIP`、`tmp` 或 `try fix` 等无意义标题。

## 本地验证

提交 Pull Request 前至少运行：

```bash
npm test
npm run build
git diff --check
```

如果改动引入了更具体的验证脚本，也要运行并在 Pull Request 中记录。不得通过删除、跳过或弱化既有测试来获得绿灯，除非改动明确改变了对应契约。

云端运行与 PostgreSQL Migration 的独立命令、配置和测试数据库隔离规则见 [`docs/CLOUD_RUNTIME.md`](./docs/CLOUD_RUNTIME.md)。

## Pull Request

- 所有改动通过 Pull Request 合入，禁止直接推送 `main` 和当前 `version/*`。
- 普通任务使用 Squash Merge；最终版本分支合入 `main` 时使用 Merge Commit。
- Pull Request 必须说明目标、改动、非目标、验证结果、契约影响、风险和回滚方式。
- 页面变化附桌面端和移动端截图。
- CI 未通过或阻断审查意见未解决时不能合并。

登录、Session、Agent Token、租户隔离、数据库 Migration、业务契约、CI/CD、密钥和生产配置属于高风险修改，必须提供对应的负向测试或恢复证据，并由维护者明确确认。

## 目录边界

- `src/` 保存应用代码，业务规则不能堆在路由或脚本入口中。
- `scripts/` 只保存构建、开发和运维入口。
- `test/` 保存自动化测试；新增模块必须带相应测试。
- `config/` 只保存可公开的非敏感配置。
- `themes/` 保存主题源文件及项目明确跟踪的确定性产物。
- `data/` 中的运行时 Candidate、正式日报和编译数据不得作为用户数据提交。
- 不为未来能力提前创建空目录；新增一级目录必须在 Pull Request 中说明稳定职责。

更具体的内容和主题 Agent 边界分别见 [`AGENT_CONTENT_GUIDE.md`](./AGENT_CONTENT_GUIDE.md) 与 [`AGENT_THEME_GUIDE.md`](./AGENT_THEME_GUIDE.md)。
