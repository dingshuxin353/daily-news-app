import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBuiltHtml } from "./lib/build-html.js";
import { validateConfiguredTheme } from "./lib/theme-pipeline.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "dist");

const activeTheme = await validateConfiguredTheme(rootDir);

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const entry of ["styles.css", "src", "config", "data"]) {
  await cp(path.join(rootDir, entry), path.join(outputDir, entry), { recursive: true });
}
const index = JSON.parse(await readFile(path.join(rootDir, "data", "index.json"), "utf8"));
const issue = index.latest
  ? JSON.parse(await readFile(path.join(rootDir, "data", "compiled", `${index.latest}.json`), "utf8"))
  : null;
const site = JSON.parse(await readFile(path.join(rootDir, "config", "site.json"), "utf8"));
const template = await readFile(path.join(rootDir, "index.html"), "utf8");
await writeFile(
  path.join(outputDir, "index.html"),
  renderBuiltHtml(template, { activeTheme, issue, site }),
  "utf8",
);
await cp(path.join(rootDir, "public"), outputDir, { recursive: true });
await mkdir(path.join(outputDir, "themes"), { recursive: true });
if (activeTheme) {
  await cp(path.join(rootDir, "themes", "active.json"), path.join(outputDir, "themes", "active.json"));
}
for (const entry of ["compiled", "previews"]) {
  await cp(
    path.join(rootDir, "themes", entry),
    path.join(outputDir, "themes", entry),
    { recursive: true },
  );
}

console.log(`静态站点已生成：${path.relative(rootDir, outputDir)}/`);
