# DailyNews App

文件驱动的 DailyNews MVP 0.4。外部 Agent 先生成包含事实、编辑判断和多来源信息的完整候选，再由项目命令写入正式日报；Node.js 将正式日报编译为确定的四格行结构，固定前端负责响应式渲染和来源查看。

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

外部 Agent 必须先阅读仓库根目录的 [`AGENT_WRITE_SPEC.md`](./AGENT_WRITE_SPEC.md)。该文档同时说明当前 MVP 0.4 的可执行边界和 MVP 0.5 的目标写入契约。

- `config/site.json`：站点名称、强调色与可选 Logo
- `data/issues/YYYY-MM-DD.json`：正式日报；只允许项目写入命令维护
- `data/compiled/YYYY-MM-DD.json`：Node.js 生成的渲染数据
- `data/index.json`：由 `npm run prepare-data` 自动生成，请勿手动维护
- `public/`：以 `/` 开头的本地公开资源路径对应目录

当前 MVP 0.4 命令会校验完整候选 JSON，并整份替换目标日期的正式日报：

```bash
npm run write-issue -- YYYY-MM-DD /path/to/candidate.json
```

候选文件未通过 v0.4 校验时，命令会失败并保留已有日报。命令成功也不会自动写入 compiled 文件或日期索引，仍需运行 `npm run prepare-data`。

该命令尚不支持同日安全合并。目标日期已存在时，除非用户明确要求完整替换，否则只保留候选并等待 MVP 0.5 统一入口。

产品边界、内容契约和视觉规范分别记录在工作区的 `docs/spec-v0.5.md`、`docs/content.md` 与 `docs/design.md` 中。
