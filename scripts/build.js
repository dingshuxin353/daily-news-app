import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfiguredTheme } from "./lib/theme-pipeline.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "dist");

const activeTheme = await validateConfiguredTheme(rootDir);

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const entry of ["index.html", "styles.css", "src", "config", "data"]) {
  await cp(path.join(rootDir, entry), path.join(outputDir, entry), { recursive: true });
}
await cp(path.join(rootDir, "public"), outputDir, { recursive: true });
await mkdir(path.join(outputDir, "themes"), { recursive: true });
if (activeTheme) {
  await cp(path.join(rootDir, "themes", "active.json"), path.join(outputDir, "themes", "active.json"));
}
for (const entry of ["compiled", "previews", "fixtures"]) {
  await cp(
    path.join(rootDir, "themes", entry),
    path.join(outputDir, "themes", entry),
    { recursive: true },
  );
}

console.log(`静态站点已生成：${path.relative(rootDir, outputDir)}/`);
