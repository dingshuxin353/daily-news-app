# DailyNews App

文件驱动的 DailyNews（MVP 完成版后的 0.7.0）。外部 Agent 只提交声明式日报或主题候选；两条独立流水线分别维护正式日报与主题 revision，前端保持确定的四格内容骨架。

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

## 主题入口

外部 Agent 生成主题前必须阅读 [`AGENT_THEME_SPEC.md`](./AGENT_THEME_SPEC.md)，且只能写 `themes/candidates/`。三个官方 Preset 是 `newspaper-default`、`swiss-editorial` 和 `midnight-tech`。

生成安全预览：

```bash
npm run process-theme -- --candidate themes/candidates/<theme-id>.json
```

运行 `npm start` 后，可打开 `/?themePreview=<theme-id>` 查看当前真实日报，追加 `&themeStress=1` 查看固定压力测试日报。预览不会修改当前 Active Theme。

用户确认审美后才可激活；命令要求用同一主题 ID 二次确认：

```bash
npm run activate-theme -- --theme <theme-id> --confirm <theme-id>
npm run rollback-theme -- --confirm
```

Theme Writer 维护 `themes/definitions/`、`themes/compiled/` 和 `themes/active.json`。不要手工覆盖这些文件。没有 Active Theme 时，页面继续使用 `config/site.json.accentColor`。

产品边界、内容契约和视觉规范分别记录在工作区的 `docs/spec-v0.7.0.md`、`docs/content.md` 与 `docs/design.md` 中。
