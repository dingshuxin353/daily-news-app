# DailyNews AI Agent 个人待办指南

适用产品版本：0.12.1
Todo Schema：1
更新日期：2026-08-24

本指南只用于唯一的本地个人待办。Agent 理解自然语言、读取当前正式 State，并交付一份完整 Todo Candidate；宿主负责校验、并发控制、正式写入、页面重建和链接验证。

## 1. 先读取，再决定是否写入

开始时读取 `config/todo.json` 和 `todo/data/state.json`。不要要求用户提供 Task ID、revision、JSON 路径或命令。

- “增加、记下”映射为 `add`。
- “改成、延期、提前”映射为 `update`。
- “完成、做完”映射为 `complete`。
- “重新打开、还没做完”映射为 `reopen`。
- “删除、不要了”映射为可恢复的 `archive`，不能物理删除。
- “恢复、撤销删除”映射为 `restore`。
- “查看、还有什么”只读取 State 并用人话回答，不创建 Candidate。

只有一个明确匹配时才能使用其正式 Task ID。存在同名或相似任务时，用日期和备注的最少差异让用户选择；没有匹配时说明未找到，不能猜测其他目标或自动新增。

相对日期按用户时区解析，并在写入前复述绝对日期。例如：“我会把截止时间记为 2026-08-28 15:00”。用户说“提醒我”时，明确说明本版本只记录截止时间，不会发送提醒或通知。

## 2. 唯一 Candidate 产物

写入路径：

```text
todo/data/candidates/<candidate-id>.json
```

完整结构：

```json
{
  "schemaVersion": 1,
  "candidateId": "20260823-submit-weekly-report",
  "generatedAt": "2026-08-23T18:20:00+08:00",
  "baseRevision": 2,
  "operations": [
    {
      "type": "add",
      "clientId": "submit-weekly-report",
      "title": "提交本周周报",
      "note": "补充产品数据部分",
      "dueDate": "2026-08-24",
      "dueTime": "15:00"
    }
  ]
}
```

- 文件名必须等于 `<candidateId>.json`；ID 只使用小写字母、数字和连字符，并在当前安装中唯一。
- `generatedAt` 是带时区时间；`baseRevision` 必须等于刚读取的正式 State revision。
- `operations` 是非空数组并按用户表达顺序排列。任一操作无效时整份 Candidate 拒绝。
- Candidate 不能声明目标 Todo、结果 revision、处理模式、权限、Publication 或第二份清单。

## 3. 操作字段

`add`：必填 `type`、当前 Candidate 内唯一的 `clientId`、非空 `title`；可选 `note`、`dueDate`、`dueTime`。正式 Task ID 由 Writer 生成，相同标题可以共存。

`update`：只包含 `type`、`taskId`、`changes`；`changes` 至少包含 `title`、`note`、`dueDate`、`dueTime` 中一项。`null` 只用于清除可选字段，清除日期时不能保留时间。

`complete`、`reopen`、`archive`、`restore`：只包含 `type` 和正式 `taskId`。归档代表可恢复删除；不存在 `delete` 或 `purge`。

标题最长 120 个字符，备注最长 500 个字符；日期使用 `YYYY-MM-DD`，时间使用 `HH:mm`。不要写入 HTML、脚本、命令、提醒动作、状态时间、正式 ID、revision 或创建时间。同一 Candidate 不能重复操作同一个正式 Task ID。

## 4. 状态与失败处理

- Agent 写完合法文件即可报告 `candidate_ready` 和 Candidate 路径；这不等于页面已经更新。
- 只有宿主返回 `published` 或 `unchanged`，且需要交付页面时真实验证 `/todo/` 后，才能说正式状态和页面已更新。
- `baseRevision` 冲突时重新读取最新 State，重新确认受影响的用户意图，再生成新的 Candidate；不能覆盖并发变化。
- 校验失败、未知 Task ID 或状态不允许时，说明失败字段和影响，不直接改 State、Submission 或页面绕过拒绝。
- Agent 不运行处理命令，不负责预览、编译、激活或写入正式结果；这些是 Host 的职责。

宿主已发布时，回复可以是：

```text
已经更新你的个人待办：

- 新增：2026-08-24 15:00 提交本周周报

个人待办事项：<真实验证过的本机 /todo/ 链接>
```

## 5. Home、Todo 与隐私边界

- `config/todo.json.enabled` 控制本地 Todo 页面和导航；关闭只停止展示与自动处理，不删除正式 State。
- Home 与 Todo 是独立开关。只有两者同时启用时 Home 才显示最多五条摘要；Home 关闭时 `/todo/` 仍可从 Publication 导航访问。
- Todo Page 与 Home Module 都是只读的本机界面，不提供网页内添加、编辑、完成或删除。
- Todo 不属于任何 Publication，不读取新闻 Candidate，也不创建独立主题；它固定跟随 Home Effective Theme。
- 普通 `npm run build` 的公开 `dist/` 绝不能包含 Todo 页面、导航、数量、标题、备注、日期、State、Candidate 或 Submission。
- 不把真实私人待办复制到文档、测试、日志、Publication 或主题文件；日志只使用 Candidate ID、revision、操作数和结果。
