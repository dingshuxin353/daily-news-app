import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileIssue } from "../scripts/lib/compiler.js";
import { buildSite } from "../scripts/lib/site-builder.js";
import { createThemeManifest } from "../scripts/lib/theme-compiler.js";
import { loadStoredTheme } from "../scripts/lib/theme-pipeline.js";
import { createTestIssue } from "./helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) process.exit(0);
const target = path.resolve(process.argv[2]);

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

for (const entry of ["home.html", "index.html", "styles.css", "src", "public", "themes"]) {
  await cp(path.join(rootDir, entry), path.join(target, entry), { recursive: true });
}
await writeFile(
  path.join(target, "public", "browser-image.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"><rect width="1200" height="800" fill="#c8b08a"/><circle cx="820" cy="340" r="210" fill="#36464b"/><path d="M0 650L380 360l300 290z" fill="#8a5b3d"/></svg>',
  "utf8",
);
await writeJson(path.join(target, "config", "publications.json"), {
  schemaVersion: 1,
  defaultPublicationId: "ai-daily",
  publicationIds: ["ai-daily", "finance-daily", "local-daily"],
});
await writeJson(path.join(target, "config", "home.json"), {
  schemaVersion: 1,
  enabled: true,
  name: "我的日报",
  accentColor: "#B37721",
  activeTheme: { id: "newspaper-default", revision: 1 },
});

async function createPublication(id, name, theme, issue = null) {
  const publication = path.join(target, "publications", id);
  await mkdir(path.join(publication, "data", "candidates"), { recursive: true });
  await mkdir(path.join(publication, "data", "issues"), { recursive: true });
  await mkdir(path.join(publication, "data", "compiled"), { recursive: true });
  await mkdir(path.join(publication, "data", "submissions"), { recursive: true });
  await mkdir(path.join(publication, "themes"), { recursive: true });
  const site = JSON.parse(await readFile(
    path.join(rootDir, "config", "site.json"),
    "utf8",
  ));
  await writeJson(path.join(publication, "config", "site.json"), { ...site, name });
  await writeJson(path.join(publication, "config", "theme.json"), theme);
  const activeTheme = theme.mode === "override"
    ? theme.activeTheme
    : { id: "newspaper-default", revision: 1 };
  const { definition, relativeCssPath } = await loadStoredTheme(
    target,
    activeTheme.id,
    activeTheme.revision,
  );
  await writeJson(
    path.join(publication, "themes", "active.json"),
    createThemeManifest(definition, relativeCssPath, null),
  );
  if (!issue) {
    await writeJson(path.join(publication, "data", "index.json"), { latest: null, dates: [] });
    return;
  }
  await writeJson(path.join(publication, "data", "issues", `${issue.date}.json`), issue);
  await writeJson(
    path.join(publication, "data", "compiled", `${issue.date}.json`),
    compileIssue(issue).compiled,
  );
  await writeJson(path.join(publication, "data", "index.json"), {
    latest: issue.date,
    dates: [issue.date],
  });
}

const aiIssue = createTestIssue("2026-08-23");
aiIssue.schemaVersion = 2;
aiIssue.items[0].image = {
  src: "/browser-image.svg",
  alt: "暖色几何图形组成的测试配图",
  width: 1200,
  height: 800,
  credit: "DailyNews 测试素材",
};
aiIssue.items[1].image = {
  src: "https://cdn.example.com/failure.jpg",
  alt: "用于验证加载失败退化的测试图片",
  width: 1200,
  height: 800,
  credit: "失败退化测试",
};
aiIssue.items.at(-1).image = {
  src: "/browser-image.svg",
  alt: "小模块中不应显示的测试图片",
  width: 1200,
  height: 800,
  credit: "DailyNews 测试素材",
};
const financeIssue = createTestIssue("2026-08-22", ["lead", "important", "normal"]);
financeIssue.schemaVersion = 2;
financeIssue.items[0].image = structuredClone(aiIssue.items[0].image);

await createPublication("ai-daily", "AI 日报", { schemaVersion: 2, mode: "inherit" }, aiIssue);
await createPublication("finance-daily", "财经日报", {
  schemaVersion: 2,
  mode: "override",
  activeTheme: { id: "midnight-tech", revision: 1 },
}, financeIssue);
await createPublication("local-daily", "本地日报", { schemaVersion: 2, mode: "inherit" });
await buildSite(target, path.join(target, "dist"), { asOfDate: "2026-08-23" });
console.log(target);
