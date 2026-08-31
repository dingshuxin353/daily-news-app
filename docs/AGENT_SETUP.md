# DailyNews Agent 接入说明

- 接入合同版本：`3.0.0`
- 适用产品：DailyNews `v1.0.0`
- 用途：让不了解 DailyNews 源码的 AI Agent 使用用户提供的 Token，完成本地远程 MCP 配置并继续建立日报任务。

## 目标结果

完成本说明后，你应当：

1. 确认当前 Agent 客户端能够原生保存和使用远程 Streamable HTTP MCP 配置。
2. 在读完本文后向用户索取一枚 DailyNews Agent Token。
3. 使用客户端自身的 MCP 配置能力保存服务地址和 Bearer Token。
4. 发现 DailyNews 工具并调用 `get_daily_context`，确认连接真实可用。
5. 继续询问用户长期关注内容和更新时间；只有客户端确实支持持久调度时才建立定时任务。
6. 立即生成第一份个性化日报，并把不含 Token 的页面链接交给用户。

## 当前服务

- MCP URL：`{{MCP_URL}}`
- Transport：Streamable HTTP
- Authorization：`Authorization: Bearer <用户提供的 DailyNews Agent Token>`

如果正文仍出现 `{{MCP_URL}}`，说明当前说明没有被正确发布。停止配置并告诉用户接入说明暂时不可用，不要猜测地址。

## 必须遵守

- 先完整读取本文，再向用户索取 Token；用户最初只需要提供本文地址。
- 只使用当前 Agent 客户端原生的 MCP 配置能力，不要求用户安装 Python、Node.js、curl、PowerShell 模块或其他运行时。
- 不使用额外脚本直接请求 DailyNews API 来代替 MCP 配置，也不因操作系统不同设计另一条接入流程。
- Token 会由用户在私密对话中提供。收到后不要复述、解释、记录或写入项目文件、任务正文、URL、日志和错误报告。
- Token 只进入当前客户端正常的 MCP 凭证配置位置；不要另建自定义 Secret 文件或旁路存储。
- 不关闭 TLS 校验，不把 HTTPS 降级为 HTTP，不通过代理、固定等待或重复创建 Token 绕过连接错误。
- 已存在可用的 DailyNews MCP 配置时直接复用，不向用户索取第二枚 Token。

## 首次配置

### 1. 检查当前客户端能力

在索取 Token 前确认当前 Agent 客户端能够：

1. 添加远程 Streamable HTTP MCP 服务。
2. 为该服务配置 Bearer Token 或等价的 `Authorization` Header。
3. 保存配置，并在需要时重新加载 MCP 服务。

这项检查只针对 Agent 客户端自身的 MCP 能力，不运行系统脚本，也不探测 Python、证书文件、Keychain 或操作系统命令。

如果客户端不能完成以上配置，停止并告诉用户：当前 Agent 客户端不能自动配置 DailyNews 远程 MCP。不要索取 Token，也不要安装额外运行时。

### 2. 向用户索取 Token

能力确认后，只向用户提出这一项请求：

> 请回到 DailyNews 的 Agent 授权页面，为我创建一枚 Agent Token，然后把本次只显示一次的完整 Token 发给我。

不要要求用户提供 Token 之外的接入材料、接口字段、JSON、配置文件路径或系统信息。

### 3. 写入原生 MCP 配置

收到 Token 后，使用当前客户端自身的 MCP 配置方式新增或更新名为 `dailynews` 的服务：

```text
name: dailynews
url: {{MCP_URL}}
transport: streamable-http
authorization: Bearer <用户提供的 Token>
```

上面的结构表达配置结果，不代表某个客户端的固定文件格式。应使用当前客户端真实支持的设置界面、配置 API、命令或配置文件结构；不要把示例原样写入未知格式。

配置完成后，按当前客户端的正常机制重新加载 MCP。不要在回复中显示 Token，也不要把完整配置内容回显给用户。

### 4. 验证连接

1. 发现 `dailynews` 服务提供的工具，不要凭记忆猜测工具输入。
2. 按工具 Schema 调用 `get_daily_context`。
3. 只有工具发现和 `get_daily_context` 都成功，才告诉用户 DailyNews 已连接。
4. Todo 或主题任务分别在需要时调用 `get_todo_context` 或 `get_theme_context`，不把它们设为首次连接的额外门槛。

### 5. 完成用户任务

连接成功后继续：

1. 用普通语言询问用户长期关注的内容。
2. 询问更新时间，把“每天早上”等相对表达确认成明确时间和时区。
3. 只有当前 Agent 确实支持持久调度时，才在 Agent 自己的环境创建或更新任务；DailyNews 服务端不托管调度。
4. 立即运行一次：先读取所需 Context，再按 MCP 工具 Schema 提交 Candidate，最后读取正式结果。
5. 把不含 Token 的私有页面链接交给用户，并说明后续任务何时运行。

## 失败处理

| 情况 | 处理方式 |
| --- | --- |
| 当前客户端不支持远程 MCP 或 Bearer 配置 | 在索取 Token 前停止，说明客户端能力不足 |
| 用户尚未提供 Token | 等待用户提供，不创建占位配置，不猜测 Token |
| MCP 返回未授权 | 告诉用户 Token 无效、已撤销或配置不完整；不要显示 Token，不自动重复创建或轮换 |
| MCP URL、TLS、网络或客户端加载失败 | 保留现有 Token 与配置，报告当前客户端给出的脱敏错误；修复后重新验证，不切换到脚本直连 |
| 工具发现成功但 `get_daily_context` 失败 | 按工具返回的结构化错误处理；不要重新配置 MCP 或索取新 Token |
| 已有配置再次运行 | 直接发现工具并继续任务，不重复索取 Token |

如果用户决定更换 Token，应由用户在 DailyNews 页面轮换或撤销目标 Token，再把新 Token 提供给你。不要替用户猜测是否应该撤销凭证。

## 完成条件

只有以下结果都真实发生，才能告诉用户 DailyNews 已经接入：

- `dailynews` 已保存为当前客户端的原生远程 MCP 配置。
- MCP 工具发现成功。
- `get_daily_context` 调用成功。
- Agent 已向用户确认长期关注内容、明确时间和时区。
- 如果声称自动更新，持久定时任务已经在 Agent 自己的环境真实建立。
- 第一份个性化日报已经形成正式结果，用户获得了不含 Token 的页面链接。

仅仅读取本文、收到 Token 或写入配置，不代表完整接入成功。

## 本说明不负责

- 不提供 JSON API、OpenAPI 或 `curl` 的高级使用教程。
- 不维护 Windows 与 macOS 两套脚本，也不要求用户具备任何额外运行时。
- 不复制 Daily、Todo 和 Theme 的完整字段 Schema；连接后以 MCP 工具 Schema 为准。
- 不托管 Agent、模型、内容搜集、提示词或定时任务。
- 不为不同 Agent 客户端维护固定配置路径或伪造通用命令。
