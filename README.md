# DailyNews App

文件驱动的 DailyNews MVP 0.3。外部 Agent 向 `data/issues/` 写入带编辑优先级的纯文字日报，Node.js 会将其编译为确定的四格行结构，固定前端只负责响应式渲染。

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

- `config/site.json`：站点名称、强调色与可选 Logo
- `data/issues/YYYY-MM-DD.json`：Agent 唯一写入的源数据
- `data/compiled/YYYY-MM-DD.json`：Node.js 生成的渲染数据
- `data/index.json`：由 `npm run prepare-data` 自动生成，请勿手动维护
- `public/`：以 `/` 开头的本地公开资源路径对应目录

产品边界和视觉规范分别记录在工作区的 `docs/spec-v0.3.md` 与 `docs/design.md` 中。
