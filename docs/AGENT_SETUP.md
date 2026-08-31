# DailyNews Agent 接入索引

- 接入合同版本：`3.1.0`
- 适用产品：DailyNews `v1.0.0`
- 用途：让 AI Agent 先进入与自身客户端匹配的操作手册，再使用用户提供的 Token 完成本地远程 MCP 配置。

本文是面向 Agent 的共享接入索引，不承载任何客户端的具体配置格式。客户端操作必须采用独立 Markdown 文件和独立 URL。新增客户端时新增文件与路由，不把配置步骤继续堆入本文，也不引入 JSON discovery 或客户端自动嗅探。

## 目标结果

完成整个接入流程后，你应当：

1. 识别自己正在运行的 Agent 客户端。
2. 完整读取对应客户端操作手册。
3. 按手册确认该客户端能够原生保存远程 Streamable HTTP MCP 与 Bearer Token。
4. 确认能力后向用户索取一枚 DailyNews Agent Token。
5. 按客户端手册写入配置、重新加载并发现 DailyNews 工具。
6. 调用 `get_daily_context` 确认连接，再继续关注内容、更新时间和首份日报。

## 当前服务

- MCP URL：`{{MCP_URL}}`
- Transport：Streamable HTTP
- Authorization：`Authorization: Bearer <用户提供的 DailyNews Agent Token>`

## 选择客户端手册

先判断当前正在运行的客户端，再读取匹配文件：

| 客户端 | 操作手册 | 当前范围 |
| --- | --- | --- |
| Codex 桌面端、Codex CLI、Codex IDE 扩展 | [读取 Codex 操作手册](./agent-setup/codex.md) | 已支持 |

只有表中列出的文件属于当前接入合同。当前客户端没有对应手册时，告诉用户该客户端的 DailyNews 操作手册尚未提供；不要猜测配置格式，也不要先索取 Token。

## 共享规则

- 用户最初只需要提供本页地址；先读完本页和匹配的客户端手册，再索取 Token。
- 只使用当前 Agent 客户端原生支持的 MCP 配置能力，不要求用户安装 Python、Node.js、curl、PowerShell 模块或其他辅助运行时。
- 不使用脚本直接请求 DailyNews API 来代替 MCP 配置，也不因 Windows 与 macOS 设计两条产品流程。
- Token 会由用户在私密对话中提供。收到后不要复述、解释、记录到项目文件、任务正文、URL、日志或错误报告。
- Token 只写入对应客户端手册指定的原生 MCP 配置位置，不建立第二份 Secret 文件或旁路存储。
- 不关闭 TLS 校验，不把 HTTPS 降级为 HTTP，不通过代理、固定等待或重复创建 Token 绕过连接错误。
- 已存在可用的 `dailynews` MCP 配置时直接复用，不向用户索取第二枚 Token。

## 索取 Token

只有客户端手册中的能力检查通过后，才向用户提出这一项请求：

> 请回到 DailyNews 的 Agent 授权页面，为我创建一枚 Agent Token，然后把本次只显示一次的完整 Token 发给我。

不要要求用户提供 Token 之外的接入材料、接口字段、JSON、配置文件路径或系统信息。

## 连接后的统一验证

客户端手册完成写入和重新加载后：

1. 发现 `dailynews` 服务提供的工具，不凭记忆猜测工具输入。
2. 按工具 Schema 调用 `get_daily_context`。
3. 只有工具发现和 `get_daily_context` 都成功，才告诉用户 DailyNews 已连接。
4. Todo 或主题任务分别在需要时调用 `get_todo_context` 或 `get_theme_context`，不把它们设为首次连接的额外门槛。

## 完成用户任务

连接成功后继续：

1. 用普通语言询问用户长期关注的内容。
2. 询问更新时间，把“每天早上”等相对表达确认成明确时间和时区。
3. 只有当前 Agent 确实支持持久调度时，才在 Agent 自己的环境创建或更新任务；DailyNews 服务端不托管调度。
4. 立即运行一次：先读取所需 Context，再按 MCP 工具 Schema 提交 Candidate，最后读取正式结果。
5. 把不含 Token 的私有页面链接交给用户，并说明后续任务何时运行。

## 共享失败处理

| 情况 | 处理方式 |
| --- | --- |
| 当前客户端没有操作手册 | 告诉用户该客户端尚未纳入当前接入支持，不猜测配置格式，不索取 Token |
| 用户尚未提供 Token | 等待用户提供，不创建占位配置，不猜测 Token |
| MCP 返回未授权 | 告诉用户 Token 无效、已撤销或配置不完整；不显示 Token，不自动重复创建或轮换 |
| MCP URL、TLS、网络或客户端加载失败 | 保留现有配置，报告客户端给出的脱敏错误；修复后重新验证，不切换到脚本直连 |
| 工具发现成功但 `get_daily_context` 失败 | 按工具返回的结构化错误处理；不重新配置 MCP 或索取新 Token |
| 已有配置再次运行 | 直接发现工具并继续任务，不重复索取 Token |

如果用户决定更换 Token，应由用户在 DailyNews 页面轮换或撤销目标 Token，再把新 Token 提供给你。不要替用户猜测是否应该撤销凭证。

## 完成条件

只有以下结果都真实发生，才能告诉用户 DailyNews 已经接入：

- 当前客户端对应的独立操作手册已经完整执行。
- `dailynews` 已保存为当前客户端的原生远程 MCP 配置。
- MCP 工具发现成功。
- `get_daily_context` 调用成功。
- Agent 已向用户确认长期关注内容、明确时间和时区。
- 如果声称自动更新，持久定时任务已经在 Agent 自己的环境真实建立。
- 第一份个性化日报已经形成正式结果，用户获得了不含 Token 的页面链接。

仅仅读取说明、收到 Token 或写入配置，不代表完整接入成功。

## 文件路由合同

运行时按文件提供 Markdown：

| 运行时路由 | 职责 |
| --- | --- |
| `/agent-setup.md` | 共享入口、客户端选择、Token 顺序与连接后统一流程 |
| `/agent-setup/codex.md` | Codex 独有的配置、重新加载与验证步骤 |

所有文件都以 `text/markdown; charset=utf-8` 返回，使用同一套当前 MCP URL 运行时渲染。路由只暴露明确登记的文件，不扫描目录生成第二份 discovery。

## 本说明不负责

- 不提供 JSON API、OpenAPI 或 `curl` 的高级使用教程。
- 不复制 Daily、Todo 和 Theme 的完整字段 Schema；连接后以 MCP 工具 Schema 为准。
- 不托管 Agent、模型、内容搜集、提示词或定时任务。
- 不在共享入口内维护任何客户端的具体配置格式。
