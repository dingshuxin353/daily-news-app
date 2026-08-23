# DailyNews Agent 工作入口

本仓库同时接受用户配置与使用支持，以及源码开发任务。开始前先判断任务类型，只读取并修改对应范围。

## 任务路由

| 任务 | 必须先读 | 目标 |
| --- | --- | --- |
| 第一次使用、配置、启动、获取链接、生成日报、调整主题或排查问题 | [`AGENT_USER_GUIDE.md`](./AGENT_USER_GUIDE.md) | 由统一指南理解用户意图，再读取当前任务需要的专项说明并完成真实验证 |
| 修改源码、测试或工程文档 | 本文件、[`CONTRIBUTING.md`](./CONTRIBUTING.md) 和相关源码、测试 | 与任务直接相关的最小改动 |

面向用户的任务不能只根据本文件猜测配置或直接写入。先由 `AGENT_USER_GUIDE.md` 判断是否需要配置、内容或主题专项说明；只读取当前任务需要的文档。

内容和主题任务不要混在同一个 Candidate 中。Agent 完成 Candidate 后即可报告结果，不要求所有 Agent 软件都能运行命令、启动服务或操作浏览器；后续消费、编译和正式写入由宿主环境负责。内容或主题任务开始前必须先由用户或宿主确定唯一目标 Publication。默认 Publication 只简化阅读入口，不能替模糊的写入任务选择目标。

## 写入边界

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

## 源码开发边界

- 遵守 `CONTRIBUTING.md` 中的分支、提交、Pull Request、验证和目录规则。
- 不把 Candidate、正式数据、编译产物和源码改动混成同一种职责。
- 不绕过现有 Validator、Writer 或 Compiler 直接生成正式产物。
- 不改变四格布局、内容顺序或 Agent 契约，除非当前任务明确要求。
- 只修改与任务直接相关的文件；保留工作区中已有的无关改动。
- 修改实现后，至少运行与改动相关的测试；准备发布时运行 `npm test` 和 `npm run build`。
