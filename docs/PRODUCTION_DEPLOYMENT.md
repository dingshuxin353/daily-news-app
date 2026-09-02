# Production Deployment Runbook

状态：`v1.0.0` 生产发布合同；尚未部署生产或正式发布。

本文是 DailyNews 单机生产部署、备份、恢复、监控和回退的唯一 Runbook。它复用 [`CLOUD_RUNTIME.md`](./CLOUD_RUNTIME.md) 的应用合同和 [`TEST_DEPLOYMENT.md`](./TEST_DEPLOYMENT.md) 已验证的不可变 release 模型，只记录生产环境新增的闸门。所有真实地址、账号、路径、凭证和联系人都保存在私有部署记录中，不进入 Git。

## 1. 固定边界

- 唯一生产 Origin 通过 Nginx 提供 HTTPS；网页、`/agent-setup.md`、`/api/v1` 和 `/mcp` 共用该 Origin。
- Node.js 22 应用与 PostgreSQL 15+ 只监听回环地址；systemd 是唯一应用进程管理器。
- 每个 release 对应一个不可变 commit；运行中的目录不执行 `git pull`，服务账户不能写 release。
- 生产使用空数据库和独立 Secret，不复制测试用户、Token、日报、Todo、主题、数据库或环境文件。
- `MAIL_MODE=ses`；Fake Mail、测试 OTP 读取、调试 Header 和请求正文日志不得进入生产。
- 每日一次 `pg_dump` 上传到服务器外对象存储，保留最近 7 份成功备份；正式开放前完成一次隔离恢复。
- 不增加 staging、Docker、Kubernetes、自动 CD、自建监控栈、Redis、队列、蓝绿或多机。

生产与测试的差异只有以下几项：

| 项目 | 生产要求 |
| --- | --- |
| 来源 | 经过授权的 annotated RC Tag；正式发布后同一 commit 的 `v1.0.0` Tag |
| 数据 | 全新生产数据库，不导入测试数据 |
| 邮件 | 已验证发件身份的腾讯云 SES |
| Origin | 已备案、DNS 与 TLS 生效的唯一生产域名 |
| 保障 | 站外备份、隔离恢复和腾讯云基础告警 |

## 2. 私有部署记录与授权闸门

开始任何操作前，在 Git 外记录：

- 生产 SSH 主机、端口、账户和已核对的 Host Key；
- 生产 Origin、备案状态、DNS 控制权和 TLS 证书归属；
- release 根目录、外置环境文件、部署账户、服务账户 / 组、systemd 单元和应用回环端口；
- Node.js 22 runtime、PostgreSQL 版本和数据库备份角色；
- SES 发件身份、服务器外对象存储目标、腾讯云告警联系人；
- 当前 RC Tag、完整 commit、成功 CI run 和回退目标。

缺少任一项时只记录“未核验”，不得猜测或借用测试环境。阶段授权如下：

- M6-A 只允许只读预检、本文与版本元数据变更。
- M6-B 才允许改变服务器、DNS、TLS、数据库、对象存储或告警配置。
- 合入 `main`、创建 RC Tag、真实发信、生产部署、恢复演练、正式 Tag 和 GitHub Release 各自遵守上层实施 Spec 的独立闸门。

## 3. 只读生产预检

使用私有记录中的生产 SSH 入口，先核对 Host Key，再执行不改变状态的检查：

```bash
uname -a
cat /etc/os-release
nproc
free -h
df -hT
timedatectl status
ss -ltnp
systemctl is-system-running
nginx -v
node --version
npm --version
psql --version
```

同时从腾讯云控制台只读核对实例规格、公网地址、安全组、系统盘、带宽、地域、时间同步、DNS、备案、证书、SES、对象存储和告警联系人。不要运行安装、升级、写文件、重启、reload、发信或数据库连接命令。

通过条件：

- 实机资源与已购买规格一致，磁盘和内存有足够余量，时间同步正常。
- SSH 只暴露预期入口；计划中的应用和 PostgreSQL 端口不对公网开放。
- 操作系统支持 Node.js 22、PostgreSQL 15+、Nginx 和 systemd。
- Origin、备案、DNS、TLS、SES、站外对象存储和告警联系人均有明确归属。

## 4. 生产环境准备合同

M6-B 获得授权后，按 [`TEST_DEPLOYMENT.md`](./TEST_DEPLOYMENT.md) 的部署账户 / 服务账户分离、release 外稳定 Node.js 22 runtime、外置 `0600` 环境文件和回环监听方式准备机器。生产必须另外满足：

- 服务账户只能读取 Node.js runtime、当前 release 和环境文件；不能登录、构建或修改 release。
- PostgreSQL 使用独立最小权限应用角色和独立备份角色；数据库与角色均为生产专用。
- 外置环境文件只采用 [`.env.example`](../.env.example) 的现有字段，不新增第二套配置文件；所有占位值必须替换。
- `CLOUD_ORIGIN` 是唯一 HTTPS 生产 Origin，`CLOUD_BASE_PATH` 默认空，`CLOUD_HOST=127.0.0.1`。
- `AGENT_API_BASE_URL` 与 `AGENT_MCP_URL` 必须由同一 Origin 和 Base Path 派生。
- 三枚应用 Secret 至少 32 字符、互不相同，且与测试环境完全不同。
- `MAIL_MODE=ses`，所有 `TENCENT_SES_*` 字段来自已验证的生产发件身份。
- 同机回环 PostgreSQL 使用 `PG_SSL_MODE=disable`；只有真实跨机且证书链已验证时才使用 `require`。

不得输出整个环境。完成候选构建后，由服务账户执行下面的失败关闭校验，只输出固定结果：

```bash
runuser -u "$PROD_SERVICE_USER" -- env \
  PATH="$PROD_RUNTIME_PATH" \
  PROD_ENV_FILE="$PROD_ENV_FILE" \
  PROD_RELEASE_DIR="$PROD_RELEASE_DIR" \
  sh -c '
    set -eu
    set -a
    . "$PROD_ENV_FILE"
    set +a
    cd "$PROD_RELEASE_DIR"
    node --input-type=module -e '\''import("./.cloud-dist/src/cloud/config.js").then(({ loadCloudConfig }) => loadCloudConfig()).then(() => console.log("production-config=ok")).catch(() => process.exit(1))'\''
  '
```

## 5. 不可变 RC release

只有 Git 管理 Agent 已创建获授权的 annotated RC Tag 后才能继续。候选必须来自 `main`，且 Tag、commit 与成功 CI 完全一致：

```bash
test "$(git cat-file -t "$PROD_RC_TAG")" = "tag"
PROD_DEPLOY_COMMIT="$(git rev-list -n 1 "$PROD_RC_TAG")"
test "$PROD_DEPLOY_COMMIT" = "$PROD_APPROVED_COMMIT"
git merge-base --is-ancestor "$PROD_DEPLOY_COMMIT" origin/main
```

为该完整 commit 新建 release，沿用测试 Runbook 的 Node.js 22 同源校验后执行：

```bash
git clone --filter=blob:none https://github.com/dingshuxin353/daily-news-app.git "$PROD_RELEASE_DIR"
cd "$PROD_RELEASE_DIR"
git checkout --detach "$PROD_DEPLOY_COMMIT"
test "$(git rev-parse HEAD)" = "$PROD_DEPLOY_COMMIT"
test -z "$(git status --short)"
PATH="$PROD_RUNTIME_PATH" npm ci
PATH="$PROD_RUNTIME_PATH" npm run build:cloud
chown -R root:"$PROD_SERVICE_GROUP" "$PROD_RELEASE_DIR"
chmod -R u=rwX,g=rX,o= "$PROD_RELEASE_DIR"
runuser -u "$PROD_SERVICE_USER" -- test -r "$PROD_RELEASE_DIR/.cloud-dist/src/cloud/server.js"
runuser -u "$PROD_SERVICE_USER" -- test ! -w "$PROD_RELEASE_DIR"
```

锁定依赖、静态构建与云端构建必须已在同一 commit 的 CI 中通过。服务器不通过临时改 lockfile、所有权或 PATH 修补失败的 release。

## 6. Migration、切换与健康

由服务账户加载外置环境，在同一个稳定 Node.js 22 runtime 中执行唯一入口：

```bash
runuser -u "$PROD_SERVICE_USER" -- env \
  PATH="$PROD_RUNTIME_PATH" \
  PROD_ENV_FILE="$PROD_ENV_FILE" \
  PROD_RELEASE_DIR="$PROD_RELEASE_DIR" \
  sh -c '
    set -eu
    set -a
    . "$PROD_ENV_FILE"
    set +a
    cd "$PROD_RELEASE_DIR"
    test "$(node -p "process.versions.node.split(\".\")[0]")" = "22"
    npm run db:migrate
  '
```

空库第一次应应用全部 Migration；立即重复执行必须返回 `0 applied`。两次执行前后 release 都必须不可写且 Git 干净。失败时不启动应用，不手工改 `app.schema_migrations`，不执行 Down Migration。

systemd 使用 `<稳定 Node.js 22 runtime>/node .cloud-dist/src/cloud/server.js`、`WorkingDirectory=<release 根目录>/current`、外置环境文件、`SIGTERM` 和至少 10 秒停止窗口。确认 `current` 是指向已记录 release 的符号链接后才原子切换并重启。

Nginx 复用测试 Runbook 的代理 Header 清理合同，但使用唯一生产 Origin 与有效 TLS；若存在 `www`，它只能跳转到该 Origin。切换后验证：

```bash
ss -ltnp
systemctl status "$PROD_SYSTEMD_UNIT" --no-pager
nginx -t
curl --fail --silent --show-error "$PROD_ORIGIN/health/live"
curl --fail --silent --show-error "$PROD_ORIGIN/health/ready"
curl --fail --silent --show-error --output /dev/null "$PROD_ORIGIN/"
curl --fail --silent --show-error --output /dev/null "$PROD_ORIGIN/login"
```

应用与 PostgreSQL 必须只监听回环；live 和 ready 都为 200，公开页与登录页可达，HTTP 只跳转到同域 HTTPS，日志扫描不得命中 Cookie、OTP、Token、Authorization、连接串或私人正文。

## 7. 站外备份与隔离恢复

备份使用 PostgreSQL custom format、`--no-owner --no-privileges`，由独立备份角色每天执行一次。每次任务按以下顺序完成：

1. 在受限临时目录生成带 UTC 时间和数据库标识的 `.dump`。
2. 计算 SHA-256，使用所选对象存储的官方工具上传到服务器外的私有目标。
3. 读回远端对象的存在、大小和校验值；只有该步成功才记为成功备份并删除本地临时文件。
4. 只删除同一生产数据库超过最近 7 份的已验证成功备份；上传或校验失败时不执行保留期删除。
5. 任一步失败都返回非零，并由腾讯云现有通知渠道告警；日志只记录时间、对象键、大小、校验值和结果。

对象存储供应商、目标、认证方式和官方上传 / 删除命令必须先写入私有部署记录。信息未确定时不得用本机目录、同服务器目录或测试 Bucket 冒充站外备份。

正式开放前，在临时隔离数据库执行一次恢复：

1. 下载最新已验证备份并复核 SHA-256。
2. 新建不可被应用连接的临时数据库，使用 `pg_restore --clean --if-exists --no-owner --no-privileges` 恢复。
3. 只核对 `app.schema_migrations` 与核心表存在、Migration 数量、记录数量摘要；不输出用户内容。
4. 记录开始 / 完成时间、备份对象、校验值、PostgreSQL 版本和结果。
5. 取得恢复演练授权后删除临时数据库和本地备份文件。

恢复失败会阻断开放；不能以 `pg_dump` 成功代替恢复证明。

## 8. 腾讯云基础告警

使用腾讯云现有监控与通知渠道，至少覆盖：

- CPU、内存和系统盘使用率；
- 实例不可达与异常重启；
- 备份任务失败；
- 从公网访问 `/health/live` 与 `/health/ready` 的失败。

阈值、持续时间、通知联系人和升级路径保存在私有部署记录中。每条告警必须实际触发一次测试通知并读回送达；未送达即未完成。系统日志沿用 journald 与 Nginx 轮转，不建设第二套日志或监控平台。

## 9. 回退、验收与正式发布

应用回退只切换到已构建、已记录且与当前数据库 Migration 兼容的上一 release。停止应用、原子切换 `current`、启动并验证 live / ready；随后用相同步骤恢复候选。不得回滚数据库或修改环境文件来迎合旧 release。

生产验收只记录非敏感证据：Tag / commit / CI、release 路径、Node.js / PostgreSQL / Nginx / 系统版本、两次 Migration 摘要、监听范围、状态码、资源快照、备份 / 恢复、告警送达、回退 / 恢复和未执行项。

用户确认真实生产效果前，不创建正式 `v1.0.0` Tag 或 GitHub Release，也不宣布上线。正式 Tag 必须与已验收 RC commit 完全相同；发布后不再为版本号制造新 commit。
