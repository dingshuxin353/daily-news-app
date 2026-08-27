import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildLocalSite, buildSite } from "../scripts/lib/site-builder.js";
import { compileIssue } from "../scripts/lib/compiler.js";
import { switchHomeTheme } from "../scripts/lib/home.js";
import { switchTheme } from "../scripts/lib/theme-pipeline.js";
import { createTestIssue, seedTestData } from "../test-support/helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createPublication(target, publicationId, name) {
  const publication = path.join(target, "publications", publicationId);
  await mkdir(path.join(publication, "config"), { recursive: true });
  await mkdir(path.join(publication, "themes"), { recursive: true });
  await mkdir(path.join(publication, "data", "submissions"), { recursive: true });
  const site = JSON.parse(await readFile(path.join(rootDir, "config", "site.json")));
  site.name = name;
  await writeJson(path.join(publication, "config", "site.json"), site);
  await cp(path.join(rootDir, "config", "theme.json"), path.join(publication, "config", "theme.json"));
  await cp(path.join(rootDir, "themes", "active.json"), path.join(publication, "themes", "active.json"));
  await seedTestData(publication);
  const candidate = structuredClone(createTestIssue("2026-08-20"));
  delete candidate.revision;
  await writeJson(path.join(publication, "data", "candidates", "2026-08-20.json"), candidate);
  return publication;
}

async function fixture() {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-build-"));
  for (const entry of ["index.html", "home.html", "todo.html", "styles.css", "todo.css", "src", "public", "themes"]) {
    await cp(path.join(rootDir, entry), path.join(target, entry), { recursive: true });
  }
  await mkdir(path.join(target, "config"), { recursive: true });
  await writeJson(path.join(target, "config", "publications.json"), {
    schemaVersion: 1,
    defaultPublicationId: "ai-daily",
    publicationIds: ["ai-daily", "finance-daily"],
  });
  const home = JSON.parse(await readFile(path.join(rootDir, "config", "home.json"), "utf8"));
  await writeJson(path.join(target, "config", "home.json"), { ...home, enabled: false });
  await cp(path.join(rootDir, "config", "todo.json"), path.join(target, "config", "todo.json"));
  await createPublication(target, "ai-daily", "AI 日报");
  const finance = await createPublication(target, "finance-daily", "财经日报");
  await switchTheme(target, "midnight-tech", {
    confirm: "midnight-tech",
    revision: 1,
    storageRoot: finance,
  });
  return target;
}

async function seedTodo(target, { enabled = true } = {}) {
  await writeJson(path.join(target, "config", "todo.json"), { schemaVersion: 1, enabled });
  await mkdir(path.join(target, "todo", "data", "candidates"), { recursive: true });
  await mkdir(path.join(target, "todo", "data", "submissions"), { recursive: true });
  await writeJson(path.join(target, "todo", "data", "state.json"), {
    schemaVersion: 1,
    revision: 1,
    updatedAt: "2026-08-23T18:30:00+08:00",
    items: [
      {
        id: "todo-11111111",
        title: "PRIVATE-TODO-PROBE-OVERDUE <script>alert(1)</script>",
        note: "PRIVATE-TODO-NOTE",
        dueDate: "2026-08-22",
        dueTime: "15:00",
        status: "open",
        createdAt: "2026-08-20T10:00:00+08:00",
        updatedAt: "2026-08-23T18:30:00+08:00",
        completedAt: null,
        archivedAt: null,
      },
      {
        id: "todo-22222222",
        title: "今天任务",
        dueDate: "2026-08-23",
        status: "open",
        createdAt: "2026-08-21T10:00:00+08:00",
        updatedAt: "2026-08-23T18:30:00+08:00",
        completedAt: null,
        archivedAt: null,
      },
      {
        id: "todo-33333333",
        title: "今天完成",
        status: "completed",
        createdAt: "2026-08-20T10:00:00+08:00",
        updatedAt: "2026-08-23T17:00:00+08:00",
        completedAt: "2026-08-23T17:00:00+08:00",
        archivedAt: null,
      },
    ],
  });
}

test("构建为每个 Publication 生成独立入口、数据和首帧主题，根路径进入默认项", async () => {
  const target = await fixture();
  const { outputDir } = await buildSite(target);
  const rootHtml = await readFile(path.join(outputDir, "index.html"), "utf8");
  const aiHtml = await readFile(path.join(outputDir, "p", "ai-daily", "index.html"), "utf8");
  const financeHtml = await readFile(path.join(outputDir, "p", "finance-daily", "index.html"), "utf8");

  assert.match(rootHtml, /location\.replace\("\/p\/ai-daily\/"\)/);
  assert.match(aiHtml, /<span class="brand__name">AI 日报<\/span>/);
  assert.match(aiHtml, /data-theme="newspaper-default"/);
  assert.match(financeHtml, /<span class="brand__name">财经日报<\/span>/);
  assert.match(financeHtml, /data-theme="midnight-tech"/);
  assert.match(financeHtml, /<a href="\/">总览<\/a>/);
  assert.match(financeHtml, /<a href="\/p\/finance-daily\/" aria-current="page">财经日报<\/a>/);
  assert.match(financeHtml, /<option value="\/">总览<\/option>/);
  assert.match(financeHtml, /<option value="\/p\/ai-daily\/">AI 日报<\/option>/);
  assert.match(financeHtml, /<option value="\/p\/finance-daily\/" selected>财经日报<\/option>/);
  assert.match(financeHtml, /2026-08-19 最新一期来源清单/);

  const aiIssue = JSON.parse(await readFile(
    path.join(outputDir, "p", "ai-daily", "data", "compiled", "2026-08-19.json"),
  ));
  const financeIssue = JSON.parse(await readFile(
    path.join(outputDir, "p", "finance-daily", "data", "compiled", "2026-08-19.json"),
  ));
  assert.deepEqual(aiIssue.items, financeIssue.items);
  await assert.rejects(
    () => stat(path.join(outputDir, "p", "ai-daily", "data", "candidates", "2026-08-20.json")),
    /ENOENT/,
  );
});

test("Home 开启时根路径生成总览、真实深链、目录和独立主题 Manifest", async () => {
  const target = await fixture();
  const homePath = path.join(target, "config", "home.json");
  const home = JSON.parse(await readFile(homePath, "utf8"));
  await writeJson(homePath, { ...home, enabled: true, name: "我的日报" });
  await writeJson(path.join(target, "publications", "ai-daily", "config", "theme.json"), {
    schemaVersion: 2,
    mode: "inherit",
  });

  const { outputDir, overview } = await buildSite(target, undefined, { asOfDate: "2026-08-23" });
  const homeHtml = await readFile(path.join(outputDir, "index.html"), "utf8");
  const overviewOutput = JSON.parse(await readFile(
    path.join(outputDir, "home", "data", "overview.json"),
    "utf8",
  ));
  const active = JSON.parse(await readFile(
    path.join(outputDir, "home", "themes", "active.json"),
    "utf8",
  ));

  assert.equal(overview.asOfDate, "2026-08-23");
  assert.deepEqual(overviewOutput, overview);
  assert.equal(active.themeId, "newspaper-default");
  assert.match(homeHtml, /<h1>我的日报<\/h1>/);
  assert.match(homeHtml, /<a href="\/" aria-current="page">总览<\/a>/);
  assert.match(homeHtml, /<option value="\/" selected>总览<\/option>/);
  assert.match(homeHtml, /\/p\/ai-daily\/\?date=2026-08-19#test-item-1/);
  assert.ok(homeHtml.indexOf("AI 日报") < homeHtml.indexOf("财经日报"));

  await switchHomeTheme(target, "swiss-editorial", {
    revision: 1,
    confirm: "swiss-editorial",
  });
  await buildSite(target, undefined, { asOfDate: "2026-08-23" });
  const nextHome = await readFile(path.join(outputDir, "index.html"), "utf8");
  const nextAi = await readFile(path.join(outputDir, "p", "ai-daily", "index.html"), "utf8");
  const nextFinance = await readFile(path.join(outputDir, "p", "finance-daily", "index.html"), "utf8");
  assert.match(nextHome, /data-theme="swiss-editorial"/);
  assert.match(nextAi, /data-theme="swiss-editorial"/);
  assert.match(nextFinance, /data-theme="midnight-tech"/);
});

test("构建失败保留上一份正式 dist", async () => {
  const target = await fixture();
  const { outputDir } = await buildSite(target);
  const previous = await readFile(path.join(outputDir, "index.html"), "utf8");
  const homePath = path.join(target, "config", "home.json");
  const home = JSON.parse(await readFile(homePath, "utf8"));
  await writeJson(homePath, { ...home, accentColor: "invalid" });

  await assert.rejects(() => buildSite(target), /accentColor/);
  assert.equal(await readFile(path.join(outputDir, "index.html"), "utf8"), previous);
});

test("继承 Publication 的 Active Manifest 与 Home 不一致时构建失败关闭", async () => {
  const target = await fixture();
  await writeJson(path.join(target, "publications", "ai-daily", "config", "theme.json"), {
    schemaVersion: 2,
    mode: "inherit",
  });
  const homePath = path.join(target, "config", "home.json");
  const home = JSON.parse(await readFile(homePath, "utf8"));
  await writeJson(homePath, {
    ...home,
    activeTheme: { id: "midnight-tech", revision: 1 },
  });

  await assert.rejects(
    () => buildSite(target),
    /Active Theme.*不一致/,
  );
});

test("Schema 2 图片进入 Home 投影和 Publication 无脚本退化且小模块不展示", async () => {
  const target = await fixture();
  const homePath = path.join(target, "config", "home.json");
  const home = JSON.parse(await readFile(homePath, "utf8"));
  await writeJson(homePath, { ...home, enabled: true });
  const publication = path.join(target, "publications", "ai-daily");
  const issuePath = path.join(publication, "data", "issues", "2026-08-19.json");
  const issue = JSON.parse(await readFile(issuePath, "utf8"));
  issue.schemaVersion = 2;
  issue.items[0].image = {
    src: "https://cdn.example.com/lead.jpg",
    alt: "头条测试图片",
    width: 1200,
    height: 800,
    credit: "图片来源",
    sourceUrl: "https://example.com/image-source",
  };
  issue.items.at(-1).image = {
    src: "https://cdn.example.com/small.jpg",
    alt: "小模块测试图片",
    width: 1200,
    height: 800,
    credit: "图片来源",
  };
  await writeJson(issuePath, issue);
  await writeJson(
    path.join(publication, "data", "compiled", "2026-08-19.json"),
    compileIssue(issue).compiled,
  );

  const { outputDir } = await buildSite(target, undefined, { asOfDate: "2026-08-23" });
  const homeHtml = await readFile(path.join(outputDir, "index.html"), "utf8");
  const publicationHtml = await readFile(
    path.join(outputDir, "p", "ai-daily", "index.html"),
    "utf8",
  );
  const overview = JSON.parse(await readFile(
    path.join(outputDir, "home", "data", "overview.json"),
    "utf8",
  ));
  assert.equal(overview.publications[0].highlights[0].image.src, "https://cdn.example.com/lead.jpg");
  assert.match(homeHtml, /src="https:\/\/cdn\.example\.com\/lead\.jpg"/);
  assert.match(homeHtml, /loading="eager" decoding="async" fetchpriority="high" referrerpolicy="no-referrer"/);
  assert.match(publicationHtml, /src="https:\/\/cdn\.example\.com\/lead\.jpg"/);
  assert.doesNotMatch(publicationHtml, /src="https:\/\/cdn\.example\.com\/small\.jpg"/);
});

test("公开构建即使 Todo 启用也不包含路由、导航、样式或私人探针", async () => {
  const target = await fixture();
  await seedTodo(target);
  const homePath = path.join(target, "config", "home.json");
  const home = JSON.parse(await readFile(homePath, "utf8"));
  await writeJson(homePath, { ...home, enabled: true });
  const { outputDir } = await buildSite(target, undefined, { asOfDate: "2026-08-23" });
  const files = [
    path.join(outputDir, "index.html"),
    path.join(outputDir, "p", "ai-daily", "index.html"),
    path.join(outputDir, "src", "app.js"),
    path.join(outputDir, "src", "home.js"),
  ];
  const source = (await Promise.all(files.map((filePath) => readFile(filePath, "utf8")))).join("\n");
  assert.doesNotMatch(source, /个人待办|\/todo\/|PRIVATE-TODO/);
  await assert.rejects(() => stat(path.join(outputDir, "todo")), /ENOENT/);
  await assert.rejects(() => stat(path.join(outputDir, "todo.css")), /ENOENT/);
});

test("静态构建只复制浏览器入口，不包含云端运行与 PostgreSQL 源码", async () => {
  const target = await fixture();
  const { outputDir } = await buildSite(target, undefined, { asOfDate: "2026-08-23" });
  assert.deepEqual((await readdir(path.join(outputDir, "src"))).sort(), ["app.js", "home.js"]);
  await assert.rejects(() => stat(path.join(outputDir, "src", "cloud")), /ENOENT/);
  await assert.rejects(() => stat(path.join(outputDir, "src", "adapters")), /ENOENT/);
});

test("本地构建生成 Todo 页面、Home 模块和导航，并继承 Home Theme", async () => {
  const target = await fixture();
  await seedTodo(target);
  const homePath = path.join(target, "config", "home.json");
  const home = JSON.parse(await readFile(homePath, "utf8"));
  await writeJson(homePath, { ...home, enabled: true, name: "我的日报" });
  const { outputDir, todo } = await buildLocalSite(target, { asOfDate: "2026-08-23" });
  const homeHtml = await readFile(path.join(outputDir, "index.html"), "utf8");
  const todoHtml = await readFile(path.join(outputDir, "todo", "index.html"), "utf8");
  const publicationHtml = await readFile(path.join(outputDir, "p", "ai-daily", "index.html"), "utf8");

  assert.equal(todo.homeItems.length, 2);
  assert.match(homeHtml, /class="home-todo" data-module="todo"/);
  assert.match(homeHtml, /href="\/todo\/"/);
  assert.match(homeHtml, /PRIVATE-TODO-PROBE-OVERDUE &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(homeHtml, /<script>alert\(1\)<\/script>/);
  assert.match(todoHtml, /data-theme="newspaper-default"/);
  assert.match(todoHtml, /<h2 id="todo-group-overdue">已逾期<\/h2>/);
  assert.match(todoHtml, /id="todo-11111111"/);
  assert.match(todoHtml, /PRIVATE-TODO-PROBE-OVERDUE &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(todoHtml, /<script>alert\(1\)<\/script>/);
  assert.match(todoHtml, /PRIVATE-TODO-NOTE/);
  assert.match(publicationHtml, /<a href="\/todo\/">个人待办事项<\/a>/);
});

test("Home 关闭时保留本地 Todo 页面和 Publication 导航，但不生成 Home 模块", async () => {
  const target = await fixture();
  await seedTodo(target);
  const { outputDir } = await buildLocalSite(target, { asOfDate: "2026-08-23" });
  const rootHtml = await readFile(path.join(outputDir, "index.html"), "utf8");
  const publicationHtml = await readFile(path.join(outputDir, "p", "ai-daily", "index.html"), "utf8");
  assert.match(rootHtml, /location\.replace\("\/p\/ai-daily\/"\)/);
  assert.doesNotMatch(rootHtml, /home-todo/);
  assert.match(publicationHtml, /href="\/todo\/"/);
  assert.equal((await stat(path.join(outputDir, "todo", "index.html"))).isFile(), true);
});

test("Todo 关闭时本地页面和导航消失，但 State 保持不变", async () => {
  const target = await fixture();
  await seedTodo(target, { enabled: false });
  const before = await readFile(path.join(target, "todo", "data", "state.json"), "utf8");
  const { outputDir } = await buildLocalSite(target, { asOfDate: "2026-08-23" });
  const publicationHtml = await readFile(path.join(outputDir, "p", "ai-daily", "index.html"), "utf8");
  assert.doesNotMatch(publicationHtml, /个人待办|\/todo\//);
  await assert.rejects(() => stat(path.join(outputDir, "todo")), /ENOENT/);
  assert.equal(await readFile(path.join(target, "todo", "data", "state.json"), "utf8"), before);
});
