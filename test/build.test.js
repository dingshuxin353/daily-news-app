import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  colorSchemeFor,
  renderBuiltHtml,
  renderNoscriptFallback,
} from "../scripts/lib/build-html.js";
import { compileIssue } from "../scripts/lib/compiler.js";
import { createTestIssue } from "../test-support/helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("构建 HTML 注入 Active Theme、根属性和一致的 color-scheme", async () => {
  const template = await readFile(path.join(rootDir, "index.html"), "utf8");
  const activeTheme = JSON.parse(await readFile(path.join(rootDir, "themes", "active.json"), "utf8"));
  const issue = compileIssue(createTestIssue()).compiled;
  const html = renderBuiltHtml(template, {
    activeTheme,
    issue,
    site: { name: "DailyNews Test" },
  });

  assert.match(html, /<html[^>]+data-theme="newspaper-default"[^>]+data-lead="split"/);
  assert.match(html, /<link id="active-theme" rel="stylesheet" href="\/themes\/compiled\/newspaper-default\/1\.css">/);
  assert.match(html, /<meta name="color-scheme" content="light">/);
  assert.match(html, /<title>2026-08-19 · DailyNews Test<\/title>/);
  assert.match(html, /<span class="brand__name">DailyNews Test<\/span>/);
  assert.match(html, /datetime="2026-08-19"[^>]*>2026\.08\.19<\/time>/);
  assert.doesNotMatch(html, /build:noscript/);
  assert.equal(colorSchemeFor("#0D1117"), "dark");
  assert.equal(colorSchemeFor("#FFFFFF"), "light");
});

test("深色 Active Theme 在脚本执行前写入根属性、样式表和 dark color-scheme", async () => {
  const template = await readFile(path.join(rootDir, "index.html"), "utf8");
  const issue = compileIssue(createTestIssue()).compiled;
  const activeTheme = {
    cssPath: "/themes/compiled/midnight-tech/1.css",
    attributes: {
      theme: "midnight-tech",
      density: "spacious",
      surface: "soft-gradient",
      motion: "subtle",
      masthead: "compact",
      lead: "stacked",
      important: "minimal",
      normal: "compact",
    },
    colors: { background: "#0D1117", text: "#F0F3F6" },
  };
  const html = renderBuiltHtml(template, { activeTheme, issue, site: { name: "DailyNews Test" } });
  const linkIndex = html.indexOf('id="active-theme"');
  const scriptIndex = html.indexOf('<script type="module"');
  assert.match(html, /<html[^>]+data-theme="midnight-tech"[^>]+color-scheme: dark/);
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.ok(linkIndex > 0 && linkIndex < scriptIndex);
});

test("无 JavaScript 退化区安全生成每条内容的主要来源", () => {
  const issue = {
    date: "2026-08-21",
    items: [
      {
        title: '<script>alert("x")</script>',
        sources: [{ name: "A & B", url: 'https://example.com/?q="safe"' }],
      },
      {
        title: "第二条",
        sources: [{ name: "来源二", url: "https://example.com/two" }],
      },
    ],
  };
  const html = renderNoscriptFallback(issue);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /q=&quot;safe&quot;/);
  assert.equal((html.match(/target="_blank"/g) ?? []).length, issue.items.length);
});

test("空仓构建生成明确的暂无日报状态", async () => {
  const template = await readFile(path.join(rootDir, "index.html"), "utf8");
  const activeTheme = JSON.parse(await readFile(path.join(rootDir, "themes", "active.json"), "utf8"));
  const html = renderBuiltHtml(template, {
    activeTheme,
    issue: null,
    site: { name: "DailyNews" },
  });

  assert.match(html, /<title>DailyNews<\/title>/);
  assert.match(html, /<time class="date-nav__current" aria-live="polite">—<\/time>/);
  assert.match(html, /<h1 id="noscript-title">暂无日报<\/h1>/);
});
