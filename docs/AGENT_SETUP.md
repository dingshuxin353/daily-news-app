---
name: dailynews
version: 4.0.0
description: Connect a user's AI Agent to DailyNews and create a continuously updated personal daily.
api_base: "{{API_BASE_URL}}"
---

# DailyNews Agent API-first 接入说明

本文是 DailyNews 面向 AI Agent 的普通接入合同。先完整阅读本文，再按当前任务读取对应的功能文档。

## 目标结果

完成普通接入后，你应当：

1. 确认当前宿主能够发送带自定义 Header 和 JSON Body 的 HTTPS 请求；需要自动更新时，还要确认宿主自身已有持久 Secret 与调度能力。
2. 为首次日报读取 [Content API 操作合同](./agent-setup/content.md)；Todo 或主题仅在用户实际需要时再读取对应文件。
3. 能力确认后，向用户索取一枚 DailyNews Agent Token。
4. 使用 Bearer Token 调用 `GET {{API_BASE_URL}}/publications`，再读取目标日报的 Daily Context。
5. 用普通语言确认关注内容、更新时间和时区，立即生成首份正式日报。
6. 只有宿主确实保存了凭证并建立了持久任务，才告诉用户自动更新已经建立。

不要把“说明已读取”“Token 已收到”或一次只读请求成功说成整个接入已经完成。

## 当前服务

- API Base URL：`{{API_BASE_URL}}`
- Authorization：`Authorization: Bearer <用户提供的 DailyNews Agent Token>`
- Request / Response：JSON
- 写入幂等：`Idempotency-Key`

## 能力检查

在索取 Token 前，只检查当前任务需要的能力：

- 能否向公开 HTTPS URL 发送 `GET`、`POST`、`PUT` 或 `DELETE`。
- 能否附加 `Authorization`、`Content-Type`、`Idempotency-Key` 和需要时的 `If-Match`。
- 能否读取 JSON 响应并按文档生成 JSON 请求。
- 如果用户要求每天自动更新，能否用当前 Agent 宿主已有的正常方式持久保存 Secret 并建立定时任务。

DailyNews 不要求用户安装 Python、Node.js、curl、PowerShell 模块、证书工具、客户端插件或其他辅助运行时。可以使用宿主已经具备的任意 HTTP 能力。如果当前宿主不能发送带 Header 的 HTTPS 请求，停止普通接入并明确告诉用户当前 Agent 暂不支持；不要索取 Token，也不要猜测其他配置路径。

## 功能文档

按实际任务读取，不一次加载无关能力：

| 任务 | 操作文档 | 当前用途 |
| --- | --- | --- |
| 日报与首份内容 | [Content API 操作合同](./agent-setup/content.md) | Publication、Daily Context、Candidate、正式 Issue |
| Personal Todo | [Todo API 操作合同](./agent-setup/todo.md) | Todo Context、Candidate 与正式 State |
| 自定义主题 | [Theme API 操作合同](./agent-setup/theme.md) | Theme Context、查询、新建、修改与删除 |

未提供的功能文件返回 `404`，不要猜测隐藏路径。

## 索取 Token

能力检查和当前任务所需文档读取完成后，再向用户提出这一项请求：

> 请回到 DailyNews 的 Agent 授权页面，为我创建一枚 Agent Token，然后把本次只显示一次的完整 Token 发给我。

不要要求用户提供 Token 之外的接口字段、JSON、配置文件路径或操作系统信息。

收到 Token 后：

- 不复述、不解释、不写入 URL、项目文件、任务正文、日志或错误报告。
- 当前任务只需要一次连接时，可以仅在当前受信会话中使用。
- 需要持续运行时，只能使用 Agent 宿主已有的正常 Secret 能力；没有持久 Secret 能力时不得声称自动更新已经建立。
- 已有可用 Token 时直接复用，不索取第二枚。

## 连接验证

先执行最小只读验证：

```http
GET {{API_BASE_URL}}/publications
Authorization: Bearer <用户提供的 DailyNews Agent Token>
```

成功后：

1. 选择响应中的默认 Publication；用户明确指定其他日报时再选择目标项。
2. 按 `content.md` 读取目标日期 Daily Context。
3. 只有这两个请求都成功，才告诉用户 DailyNews 已连接。
4. Todo 或主题不作为首次连接门槛。

## 完成用户任务

连接成功后继续：

1. 用普通语言询问用户长期关注的内容。
2. 询问更新时间，把“每天早上”等相对表达确认成明确时间和时区。
3. 读取 `content.md`，先取最新 Context，再使用新的 `Idempotency-Key` 提交 Content Candidate，最后读取正式 Issue。
4. 把不含 Token 的私有页面链接交给用户。
5. 只有当前 Agent 宿主确实支持调度和 Secret 持久化时，才建立或更新后续任务；DailyNews 服务端不托管 Agent 或调度器。

后续运行继续先读最新 Context。相同写入意图遇到网络超时或响应不确定时，复用同一个 key 和完全相同的 Method、URL、Header 与正文；关注范围、时间或内容变化属于新意图，使用新 key。不能确认正式结果时，先用只读接口检查正式状态，不要用新 key 盲目重写。

## 失败处理

| 情况 | 处理方式 |
| --- | --- |
| 当前宿主不能发送认证 HTTPS 请求 | 告诉用户该 Agent 暂不支持普通接入；不索取 Token，不猜测其他配置路径 |
| 用户尚未提供 Token | 等待用户提供，不创建占位值 |
| `401 invalid_token` | 告诉用户 Token 无效、已撤销或已轮换；不显示 Token，不自动创建第二枚 |
| `404` | 核对本文中的 API Base、目标 Publication 和功能文档路径，不猜测兼容地址 |
| `409` | 按功能文档重新读取最新 Context 或 revision；不覆盖正式数据绕过冲突 |
| `429` | 按 `Retry-After` 处理；不固定等待或并发重试 |
| `5xx` 或网络失败 | 保留同一写入意图的 key 与完整请求，报告脱敏错误；不能确认正式结果时不冒充成功 |
| 宿主没有持久 Secret 或调度能力 | 可以完成当前一次运行，但明确说明自动更新尚未建立 |

错误响应中的 `requestId` 可以用于脱敏排查；不要记录 Authorization 或完整请求正文中的用户内容。

## 完成条件

只有以下结果真实发生，才能告诉用户 DailyNews 已经用起来：

- 本文和本次需要的功能文档已读取。
- `GET /publications` 与目标 Daily Context 成功。
- 用户的关注内容、明确时间和时区已确认。
- 首份 Content Candidate 已提交并读回正式 Issue。
- 用户获得不含 Token 的页面链接。
- 如果声称自动更新，Agent 宿主中的持久 Secret 与定时任务均已真实建立。
- 对话、日志和结果中没有完整 Token。

## 文件路由合同

| 运行时路由 | 职责 |
| --- | --- |
| `/agent-setup.md` | API-first 入口、能力检查、Token 顺序、连接验证与完整任务 |
| `/agent-setup/content.md` | Content API 操作合同 |
| `/agent-setup/todo.md` | Todo API 操作合同 |
| `/agent-setup/theme.md` | Theme API 操作合同 |

所有文件都以 `text/markdown; charset=utf-8` 返回，并使用同一个当前 API Base URL。路由只暴露明确登记的文件，不扫描目录生成 discovery。

## 本说明不负责

- 不注册或认领 Agent，不建立账号验证流程。
- 不要求用户安装 HTTP 客户端或脚本运行时。
- 不托管 Agent、模型、内容搜集、提示词或定时任务。
- 不复制三份功能文档的完整字段定义；入口只负责把 Agent 路由到当前任务需要的文件。
