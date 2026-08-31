# M5 测试环境手工部署 Runbook

状态：`v1.0.0` M5 测试环境的唯一部署操作入口。本文只覆盖当前旧域名、现有腾讯云测试机和可丢弃测试数据，不是生产发布说明。

运行时配置的唯一字段合同仍在 [`.env.example`](../.env.example) 和 [`CLOUD_RUNTIME.md`](./CLOUD_RUNTIME.md)。本文只说明如何安全地把这些配置用于一次可复查的手工部署，不复制环境变量定义。

## 1. 授权与边界

执行前必须已经获得对应授权，并写下本次范围：

- M5-A 合入后的精确 `version/v1.0.0` commit 已通过 CI；禁止部署未合入的任务分支或本地改动。
- 服务器部署、真实 SES 冒烟和邀请测试是三个独立闸门。只有部署授权时，可以完成构建、Migration、启动和不发邮件的健康检查；`MAIL_MODE=ses` 与真实邮箱发送必须另有明确授权。
- 测试数据可整体清空，不迁移到生产，也不承诺备份或恢复。本文不创建自动备份、Down Migration、CD、容器、监控或安全平台。
- 不修改 `main`，不建立 Tag、Release，也不把旧域名宣传为公开或长期入口。
- Secret、数据库连接串、邮箱、OTP、Cookie、PAT、私人正文、宝塔登录信息和完整 Nginx 配置不得进入 Git、聊天、命令输出或验收报告。

若候选 commit 新增或修改了 `db/migrations/`，停止部署并回到产品与架构确认；M5 的应用层回退合同不覆盖数据库结构变化。

## 2. 固定拓扑与目录职责

```text
旧域名 HTTPS
  → 现有 Nginx / 宝塔终止 TLS
  → 127.0.0.1:<应用端口> 的 Node.js 22 进程
  → 同机、仅回环可达的 PostgreSQL 15 测试数据库
```

服务器继续使用现有进程管理器，不安装 PM2、容器编排或另一套守护服务。至少分开以下位置；实际绝对路径和旧域名只记录在受限的私有部署记录中：

| 职责 | 规则 |
| --- | --- |
| release 目录 | 每个精确 commit 一个只读发布目录，不在运行中的目录执行 `git pull` |
| `current` 指针 | 只指向当前 release；切换后由现有进程管理器重启 |
| 运行配置 | 位于 Git 和 release 目录之外，普通文件权限 `0600`，仅服务账户可读 |
| PostgreSQL 数据 | 由现有 PostgreSQL 15 管理，不位于源码或 release 目录 |
| 日志 | 使用现有进程管理器与 Nginx 日志；不得记录请求正文或认证材料 |

部署账户必须能够读取 release 和运行配置，但不应获得无关服务器 Secret。Node.js 与 PostgreSQL 的监听地址都必须是回环地址；宝塔管理入口继续沿用服务器已有访问控制。

## 3. 部署前记录与自动化门禁

先在私有部署记录中填写，不要写入仓库：

- 部署时间与执行人。
- 候选 commit 的完整 40 位 SHA。
- 上一个已知可运行 commit 的完整 40 位 SHA。
- 旧域名公开 Origin、`CLOUD_BASE_PATH`、应用回环端口、release 根目录、外置环境文件和进程名称。
- 对应 PR 与成功 CI run；CI 必须包含核心测试、云端测试、PostgreSQL 15 集成测试及静态/云端构建。

在干净工作区再次确认候选属于受保护版本线：

```bash
M5_DEPLOY_COMMIT='REPLACE_WITH_CANDIDATE_40_CHARACTER_SHA'
M5_PREVIOUS_COMMIT='REPLACE_WITH_PREVIOUS_40_CHARACTER_SHA'
git fetch --prune origin
git rev-parse origin/version/v1.0.0
git merge-base --is-ancestor "$M5_DEPLOY_COMMIT" origin/version/v1.0.0
git diff --quiet "$M5_PREVIOUS_COMMIT" "$M5_DEPLOY_COMMIT" -- db/migrations
```

两个 SHA 变量必须替换为私有部署记录中的完整值，不能使用示例文本或短 SHA。最后一条命令只在两端 Migration 完全相同时成功。任何命令失败都停止部署；不得用跳过测试、手工改库或在服务器上改源码绕过。

## 4. 准备精确 release

继续使用上一节已核对的 SHA，并把 release 根目录替换为私有部署记录中的绝对路径。目标 release 目录必须尚不存在；不要删除或覆盖已有目录。

```bash
M5_DEPLOY_ROOT='/absolute/path/outside-the-repository'
M5_RELEASE_DIR="$M5_DEPLOY_ROOT/releases/$M5_DEPLOY_COMMIT"
test ! -e "$M5_RELEASE_DIR"
git clone --filter=blob:none https://github.com/dingshuxin353/daily-news-app.git "$M5_RELEASE_DIR"
cd "$M5_RELEASE_DIR"
git fetch --prune origin version/v1.0.0
git checkout --detach "$M5_DEPLOY_COMMIT"
git rev-parse HEAD
git status --short
node --version
npm --version
npm ci
npm run build:cloud
```

通过条件：

- `HEAD` 精确等于候选 SHA，工作区为空。
- Node.js 主版本为 22。
- `npm ci` 使用已提交的 lockfile 完成。
- `.cloud-dist/src/cloud/server.js` 已生成；构建产物仍位于当前 release，不提交 Git。

部署机不代替 CI 重跑全部测试。若部署机本身出现依赖或构建差异，停止并作为阻断记录，不能继续启动旧产物。

## 5. 外置运行配置

以 [`.env.example`](../.env.example) 为字段清单，在 Git 之外准备新的普通环境文件。程序不会自动读取 `.env`；必须由当前 Shell 或现有进程管理器显式注入。不要把真实值复制回 `.env.example`。

部署前只核对以下关系，不输出值：

- `CLOUD_ORIGIN` 是旧域名的精确 HTTPS Origin，不含路径、查询或尾部斜杠。
- `CLOUD_BASE_PATH` 与 Nginx 暴露路径一致；根路径部署时显式留空。
- `CLOUD_HOST=127.0.0.1`，`CLOUD_PORT` 只在回环监听且不与其他服务冲突。
- `AGENT_API_BASE_URL` 精确等于公开 Origin、Base Path 与 `/api/v1` 的组合；`AGENT_MCP_URL` 同理指向 `/mcp`。
- `DATABASE_URL` 指向独立、可丢弃的本机测试库；连接串不带 `ssl*` 参数，同机回环连接使用显式 `PG_SSL_MODE=disable`。
- 三枚应用 Secret（Better Auth、身份摘要、Agent Token 摘要）各自至少 32 字符且互不相同。
- 未取得真实邮件授权时只能配置 `MAIL_MODE=fake`，且不得声称登录闭环可用；取得授权后才改为 `ses` 并注入腾讯云字段。

环境文件权限检查通过后，才在当前 release 的受限 Shell 中加载它：

```bash
M5_ENV_FILE='/absolute/path/outside-git/runtime.env'
M5_PUBLIC_ORIGIN='https://replace-with-old-test-domain.invalid'
test -f "$M5_ENV_FILE"
test "$(stat -c '%a' "$M5_ENV_FILE")" = "600"
set -a
. "$M5_ENV_FILE"
set +a
test "$CLOUD_HOST" = "127.0.0.1"
test "$CLOUD_ORIGIN" = "$M5_PUBLIC_ORIGIN"
test "$AGENT_API_BASE_URL" = "${CLOUD_ORIGIN}${CLOUD_BASE_PATH}/api/v1"
test "$AGENT_MCP_URL" = "${CLOUD_ORIGIN}${CLOUD_BASE_PATH}/mcp"
```

`stat -c` 适用于当前 Linux 测试机；不要使用会打印整个环境、连接串或 Secret 的诊断命令。环境文件更新后必须通过现有进程管理器重新加载，不能只修改磁盘文件后继续使用旧进程环境。

## 6. PostgreSQL 与唯一 Migration 入口

使用现有 PostgreSQL 管理方式建立独立测试角色和数据库，并确认 PostgreSQL 只监听回环地址。数据库名和账号不写入仓库或公开报告。

在已经加载外置环境的候选 release 中执行：

```bash
npm run db:migrate
```

这是唯一正式 Migration 入口。不要直接执行单个 SQL 文件，不要让进程管理器在每次启动时自动跑 Migration，也不要把 `npm run start:cloud` 当作 Migration 命令。

通过条件：

- 命令以成功状态结束，并只记录“已应用数量 / Migration 总数”等非敏感摘要。
- 再次执行能够安全跳过已记录 Migration。
- 后续 `/health/ready` 能通过连接与 Migration 校验。

失败时停止，不启动应用；不得手工补 `app.schema_migrations` 或修改校验和。

## 7. 现有进程管理器

在服务器现有进程管理器中建立或更新唯一 DailyNews 测试进程，使用以下合同：

| 字段 | 必须值 |
| --- | --- |
| 工作目录 | `<release 根目录>/current` |
| 启动命令 | `npm run start:cloud` |
| Node.js | 明确使用 Node.js 22 的可执行环境 |
| 环境 | 从外置 `0600` 环境文件注入；不依赖仓库 `.env` |
| 停止信号 | `SIGTERM`，至少留出应用现有 10 秒关闭窗口 |
| 故障恢复 | 进程异常退出时由现有管理器重启 |
| 开机恢复 | 使用现有管理器的开机启动能力 |
| 日志 | 受限 stdout / stderr；不打开请求正文或 Header 调试 |

首次部署时建立 `current` 符号链接；已存在时必须先确认它是符号链接且指向记录中的旧 release，再原子切换到候选 release。不要让 `current` 变成可被覆盖的普通目录。

切换后使用现有管理器完成“加载环境 → 启动或重启 → 查看进程状态”。把该服务器实际的启动、停止、重启和开机恢复操作名称写入私有部署记录，不把宝塔地址或账号写入仓库。应用日志应出现回环监听地址，不能出现 Secret 或完整凭证。

## 8. Nginx / 宝塔 HTTPS 边界

继续使用宝塔已有证书和站点，不覆盖无关站点配置。修改前使用宝塔现有能力保存目标站点配置副本；修改后先执行 Nginx 配置语法检查，再 reload。

HTTP 站点统一跳转到同一旧域名的 HTTPS。HTTPS 站点的 DailyNews location 使用以下最小代理合同；`<应用端口>` 替换为外置环境中的回环端口，location 与 `CLOUD_BASE_PATH` 保持一致：

```nginx
location / {
    proxy_pass http://127.0.0.1:REPLACE_WITH_APP_PORT;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-DailyNews-Client-IP $remote_addr;

    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Forwarded-Host "";
}
```

关键边界：

- `proxy_pass` 只能指向回环地址，不能指向 `0.0.0.0` 或公网端口。
- 必须保留真实公开 `Host`，并由 Nginx 覆盖而不是追加单值 `X-Forwarded-Proto` 和 `X-DailyNews-Client-IP`。
- 不允许客户端传入的转发 Header 穿透。应用会独立核对 Socket 来源、实际 Host、请求目标 Host、代理协议和可信外部请求 Origin；不要通过改写或伪造这些代理事实解决 `403`。浏览器自身缺少 `Origin` 或发送字面值 `null` 由应用结合 Session 绑定 CSRF 处理，不需要在 Nginx 补写该 Header。
- 若使用非空 `CLOUD_BASE_PATH`，只调整 location 匹配范围，不在 `proxy_pass` 后添加会重写路径的 URI。

## 9. 健康、公开入口与监听检查

先在服务器上确认 Node.js 与 PostgreSQL 只监听回环地址，再从服务器外通过旧域名 HTTPS 检查。实际输出只保存状态、时间和 commit，不保存 Cookie 或响应正文。

```bash
M5_PUBLIC_ORIGIN='https://replace-with-old-test-domain.invalid'
M5_PUBLIC_HOST='replace-with-old-test-domain.invalid'
set -a
. "$M5_ENV_FILE"
set +a
ss -ltnp
curl --fail --silent --show-error "$M5_PUBLIC_ORIGIN$CLOUD_BASE_PATH/health/live"
curl --fail --silent --show-error "$M5_PUBLIC_ORIGIN$CLOUD_BASE_PATH/health/ready"
curl --fail --silent --show-error --output /dev/null "$M5_PUBLIC_ORIGIN$CLOUD_BASE_PATH/"
curl --fail --silent --show-error --output /dev/null "$M5_PUBLIC_ORIGIN$CLOUD_BASE_PATH/login"
curl --silent --show-error --output /dev/null --write-out '%{http_code} %{redirect_url}\n' "http://$M5_PUBLIC_HOST$CLOUD_BASE_PATH/"
```

通过条件：

- 应用端口和 PostgreSQL 端口没有监听公网地址。
- HTTPS 证书校验成功；live 为 `200 {"status":"ok"}`，ready 为 `200 {"status":"ready"}`。
- 公开页与登录页为 `200`；HTTP 跳转到同域 HTTPS。
- 停止并重新启动测试进程后，live / ready 恢复；服务器重启恢复由现有进程管理器的开机能力在 M5-B 受控验证一次。

`live=200` 但 `ready=503` 不是部署成功。先检查 PostgreSQL 可达性和 Migration 兼容摘要，不在错误页或日志中输出连接串与 SQL。

## 10. 手工应用回退与恢复候选

M5 只验证应用层回退。执行前再次确认候选与上一个已知可运行 commit 的 `db/migrations/` 无差异，并且两个 release 都已按各自 lockfile 构建完成。

1. 记录候选的 live / ready 和当前 `current` 目标。
2. 通过现有进程管理器停止应用。
3. 让 `current` 原子指向上一个已知可运行 release。
4. 启动应用，确认 live / ready、公开页和登录页通过；记录旧 commit。
5. 再次停止应用，让 `current` 指回候选 release。
6. 启动并重复健康检查；记录恢复后的候选 commit。

回退期间不执行 Down Migration、不还原数据库、不删除测试数据，也不修改外置环境文件。任一步失败就保留现场、停止邀请并记录阻断；不能把 Nginx 临时静态页或旧进程仍在运行冒充回退成功。

## 11. M5 验收记录最小字段

每次部署或回退只保留以下脱敏事实：

- 开始 / 完成时间，候选与上一个可运行 commit。
- CI run、Migration 数量摘要、进程启动 / 重启结果。
- live / ready / 公开页 / 登录页的状态码。
- Node.js、PostgreSQL、Nginx 和操作系统版本。
- 应用与数据库监听范围，以及部署前后的 CPU、内存、磁盘、带宽和 PostgreSQL 连接数摘要。
- 回退到旧 commit 和恢复候选 commit 的结果。
- 若失败：发生时间、动作、稳定错误码或请求 ID、资源快照和归属；不保存认证材料或私人正文。

真实 OTP、Agent、两账户隔离、Todo、多日报、自定义主题、凭证变化与后续定时运行只在获得相应授权后执行，并由独立测试任务形成最终 M5 报告。未执行的项目必须写“未执行”，不能根据本 Runbook 或已有自动化推断为通过。
