# DailyNews 接入操作手册：Codex

- 指南版本：`1.0.0`
- 适用客户端：同一台本地主机上的 Codex 桌面端、Codex CLI 与 Codex IDE 扩展
- 官方依据：[OpenAI Codex MCP 文档](https://developers.openai.com/codex/mcp)

本文只负责 Codex 的 MCP 配置动作。Token 索取顺序、连接后的 DailyNews 验证、日报内容与定时任务继续由共享入口负责。

## 适用范围

仅当你正在本地主机上的 Codex 桌面端、Codex CLI 或 Codex IDE 扩展中运行时使用本文。三者在同一 Codex 主机上共享 MCP 配置。

Codex 官方支持远程 Streamable HTTP MCP、Bearer Token、用户级 `~/.codex/config.toml`，以及 `[mcp_servers.<name>]` 下的 `url` 和静态 `http_headers`。DailyNews 首次接入采用用户级配置文件，不使用项目级 `.codex/config.toml`，避免把用户 Token 放入代码仓库，也避免增加 Windows / macOS 环境变量配置分支。

## 目标配置

最终只保留一个名为 `dailynews` 的用户级配置：

```toml
[mcp_servers.dailynews]
url = "{{MCP_URL}}"
http_headers = { Authorization = "Bearer <用户提供的 DailyNews Agent Token>" }
```

`<用户提供的 DailyNews Agent Token>` 是动作占位，不得把尖括号或示例文字写进真实配置。

## 1. 检查现有配置

在索取 Token 前：

1. 使用 Codex 自己的文件能力定位当前用户的 `~/.codex/config.toml`；不要把整份文件或其中的 Header 输出到对话。
2. 只检查是否已经存在 `[mcp_servers.dailynews]`。
3. 如果已有配置包含当前 URL 与 Authorization，先按第 4 节重新加载并验证；验证成功时直接返回共享流程，不索取新 Token。
4. 只有没有配置、明确缺少认证或真实返回未授权时，才进入下一步。

这一步不要求 `codex` 命令位于系统 PATH，也不探测 Python、Node.js、shell profile、Keychain、Credential Manager 或其他操作系统设施。

## 2. 向用户索取 Token

完成检查后，按共享入口中的固定话术向用户索取一枚 Token。收到后不要复述 Token，也不要在操作说明、命令输出或最终回复中显示它。

## 3. 写入 Codex 用户级配置

使用 Codex 自己的文件编辑能力修改 `~/.codex/config.toml`：

1. 文件不存在时创建它；父目录不存在时创建 `.codex` 目录。
2. 已存在其他配置时完整保留，只新增 `[mcp_servers.dailynews]`。
3. 已存在 `dailynews` 表时原位更新 `url` 和 `http_headers`，不要追加第二个同名表。
4. 把真实 Token 作为 `Bearer ` 后的值写入 `Authorization`，按 TOML 字符串规则正确转义。
5. 不把 Token 同时写入环境变量、shell profile、项目文件或第二份 Secret 文件。
6. 修改完成后不要打印或回读包含完整 Authorization Header 的配置内容。

## 4. 重新加载 MCP

写入完成后按当前 Codex 客户端的正常方式重新加载：

- Codex 桌面端：打开 Settings → MCP servers，执行 Restart。
- Codex IDE 扩展：打开齿轮菜单 → MCP servers，执行 Restart extension。
- Codex CLI：结束当前 CLI 会话并启动一个新会话。

能够由 Agent 自己完成时不要把文件编辑工作转交给用户；只有当前宿主不允许 Agent 触发重新加载时，才请用户完成这一个客户端动作。

## 5. 验证

重新加载后：

1. 在支持命令入口的 Codex 客户端中使用 `/mcp` 查看 `dailynews` 是否已经加载；CLI 可用时也可以用 `codex mcp list` 只确认配置登记状态。
2. 从当前工具列表发现 DailyNews 工具，不猜测工具参数。
3. 调用 `get_daily_context`。
4. 成功后返回共享入口，继续询问关注内容、明确更新时间并生成首份日报。

`codex mcp list` 只能证明配置已登记，不能代替工具发现与 `get_daily_context` 的真实调用。

## 失败处理

| 情况 | 处理方式 |
| --- | --- |
| TOML 解析失败 | 只修正本次触达的 `dailynews` 表与必要语法，不覆盖其他 Codex 配置 |
| 重新加载后没有 `dailynews` | 确认修改的是当前用户级 `~/.codex/config.toml`，再重新加载一次 |
| `dailynews` 存在但未授权 | 告诉用户 Token 无效、已撤销或 Header 未正确写入；不输出 Header，不自动创建第二枚 Token |
| 当前宿主不能访问用户级配置 | 告诉用户当前 Codex 运行环境无法代为完成本地配置，不改用项目级文件或脚本旁路 |
| Windows 与 macOS 路径表达不同 | 使用 Codex 解析出的当前用户主目录，不要求用户手工换算路径，不另写操作系统脚本 |

## 完成条件

以下结果全部成立，Codex 配置步骤才算完成：

- 用户级 `config.toml` 中只有一个 `mcp_servers.dailynews` 表。
- URL 指向当前 DailyNews MCP，Authorization 使用用户提供的 Token。
- 当前 Codex 客户端已经重新加载配置。
- `dailynews` 工具已被真实发现。
- `get_daily_context` 已成功调用。
- 对话、命令输出和最终回复中没有出现完整 Token。
