# DailyNews Agent 工作入口

本仓库同时接受用户配置与使用支持，以及源码开发任务。开始前先判断任务类型，只读取并修改对应范围。

## 任务路由

| 任务 | 必须先读 | 目标 |
| --- | --- | --- |
| 第一次使用、配置、启动、获取链接、生成日报、管理个人待办、调整主题或排查问题 | [`AGENT_USER_GUIDE.md`](./AGENT_USER_GUIDE.md) | 由统一指南理解用户意图，再读取当前任务需要的专项说明并完成真实验证 |
| 修改源码、测试或工程文档 | 本文件、[`CONTRIBUTING.md`](./CONTRIBUTING.md) 和相关源码、测试 | 与任务直接相关的最小改动 |

面向用户的任务不能只根据本文件猜测配置或直接写入。先由 `AGENT_USER_GUIDE.md` 判断是否需要配置、内容、待办或主题专项说明；只读取当前任务需要的文档。

## 源码修改授权闸门

用户提供参考图、截图、设计稿、配色样例或视觉方向，只代表视觉意图，不代表允许修改源码。主题任务默认只使用已有主题或受约束 Theme Candidate，并先形成预览。

如果目标需要改动共享页面、公共样式、布局、组件、脚本或构建逻辑，先停止源码写入，并用普通人能理解的语言说明：哪些页面或手机端可能受影响，以及为什么可能影响以后更新 DailyNews 新版本和使用新功能。先提供不改源码的接近版本，并建议把超出主题能力的效果作为功能需求提交给项目开发者评估。只有用户了解影响并明确确认修改源码后，才能转入源码开发任务。

普通同意、主题预览确认、主题激活确认或用户只说“照着做”，都不构成源码修改授权。用户确认有限期里程碑实施计划并明确要求开始，或明确要求实现一个边界清楚的单项源码任务后，该授权覆盖计划或任务范围内的分支 / worktree、源码修改、测试、提交、推送、任务 PR，以及在 CI 和规定审查通过后合入指定 `version/*` 分支，不再逐项确认。

上述连续授权不包括扩大已确认范围、合入 `main`、Tag、Release、生产部署、真实数据迁移、真实外部发送、仓库保护规则修改、不可逆操作或历史 worktree 清理；这些情况仍需单独确认。

## 写入边界

开始写入前读取现有配置和工作区状态，不覆盖无法识别的用户设置，不清理、重置或删除用户文件。配置、Content Candidate、Theme Candidate、Todo Candidate、正式数据、编译产物和源码各自独立：三类 Candidate 不能混用，Agent 完成 Candidate 后即可报告；后续校验、消费、编译和正式写入由 Validator、Writer、Compiler、受控命令或宿主环境负责。

内容 Agent 不得直接修改：

- `publications/*/data/issues/`
- `publications/*/data/compiled/`
- `publications/*/data/submissions/`
- `publications/*/data/index.json`
- `publications/*/config/`
- 页面源码和构建产物

主题 Agent 不得直接修改：

- `publications/*/config/theme.json`
- `publications/*/themes/active.json`
- `themes/presets/`
- `themes/previews/`
- `themes/definitions/`
- `themes/compiled/`

已有主题的切换目标可以由 Agent 表达；正式切换由受控命令或宿主应用执行。新增和修改主题时，Agent 只写 Theme Candidate。

Todo Agent 不得直接修改 `todo/data/state.json`、`todo/data/submissions/`、`todo/data/.locks/` 或本地页面产物，也不得物理删除任务。

没有经过真实运行和验证时，不得声称“已经启动”“链接可用”“配置成功”或“已经发布”。Agent 环境无法完成某一步时，明确说明尚未完成的步骤和最少后续动作。

## 已确认的源码开发任务

- 遵守 `CONTRIBUTING.md` 中的分支、提交、Pull Request、验证和目录规则。
- 只修改用户已确认范围内的必要文件，不重构邻近代码，并保留工作区已有的无关改动。
- 不绕过现有 Validator、Writer、Compiler 或受控命令直接生成正式结果。
- 修改实现后，至少运行与改动相关的测试；准备发布时运行 `npm test` 和 `npm run build`。
- 低风险文档修改完成自检和 CI 即可；普通源码 PR 做一次独立代码审查；高风险任务增加收窄独立测试；完整独立验收每个里程碑只做一次。
