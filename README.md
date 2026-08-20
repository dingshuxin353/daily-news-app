# DailyNews App

文件驱动的 DailyNews MVP 0.6。外部 Agent 只提交完整候选，统一流水线负责安全更新正式日报、维护 revision 与固定 coverage，并根据站点配置生成确定的四格行结构。

## 本地运行

要求 Node.js 22 或更高版本。

```bash
npm start
```

打开 <http://127.0.0.1:4173>。启动前会校验站点配置和全部日报，并重新生成 `data/index.json`。

## 验证与构建

```bash
npm test
npm run build
```

`npm run build` 会先校验数据，再生成可静态部署的 `dist/`。构建失败信息包含文件路径与失败字段。

## 数据入口

外部 Agent 必须先阅读仓库根目录的 [`AGENT_WRITE_SPEC.md`](./AGENT_WRITE_SPEC.md)。

- `config/site.json`：站点名称、强调色、可选 Logo 与三档优先级数量上限
- `data/candidates/YYYY-MM-DD.json`：Agent 唯一写入的完整候选
- `data/issues/YYYY-MM-DD.json`：Issue Writer 维护的正式日报
- `data/compiled/YYYY-MM-DD.json`：Node.js 生成的渲染数据
- `data/index.json`：由 `npm run prepare-data` 自动生成，请勿手动维护
- `public/`：以 `/` 开头的本地公开资源路径对应目录

Agent 完整写入候选后，同步调用统一处理入口：

```bash
npm run process-candidate -- --candidate data/candidates/YYYY-MM-DD.json --mode update
```

默认只处理当前上海日期；修订历史日期时必须额外传入 `--allow-history`。显式完整替换使用 `--mode replace`。命令返回 `created`、`updated`、`unchanged` 或 `rejected`，失败时保留候选与全部既有正式产物。

`config/site.json.priorityLimits` 控制 `lead`、`important`、`normal` 的最大数量；非负整数表示上限，`null` 表示不限。当前默认值分别为 `1`、`2`、不限。

产品边界、内容契约和视觉规范分别记录在工作区的 `docs/spec-v0.6.md`、`docs/content.md` 与 `docs/design.md` 中。
