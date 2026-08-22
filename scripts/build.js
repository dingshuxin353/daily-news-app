import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBuiltHtml } from "./lib/build-html.js";
import { loadPublicationRegistry } from "./lib/publications.js";
import { validateConfiguredTheme } from "./lib/theme-pipeline.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "dist");

const registry = await loadPublicationRegistry(rootDir);
const publication = registry.publications.find(
  ({ publicationId }) => publicationId === registry.defaultPublicationId,
);
const activeTheme = await validateConfiguredTheme(rootDir, publication.publicationDir);

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const entry of ["styles.css", "src"]) {
  await cp(path.join(rootDir, entry), path.join(outputDir, entry), { recursive: true });
}
await mkdir(path.join(outputDir, "config"), { recursive: true });
await cp(path.join(rootDir, "config", "publications.json"), path.join(outputDir, "config", "publications.json"));
for (const name of ["site.json", "theme.json"]) {
  await cp(path.join(publication.configDir, name), path.join(outputDir, "config", name));
}
await mkdir(path.join(outputDir, "data"), { recursive: true });
await cp(path.join(publication.dataDir, "compiled"), path.join(outputDir, "data", "compiled"), { recursive: true });
await cp(path.join(publication.dataDir, "index.json"), path.join(outputDir, "data", "index.json"));
const index = JSON.parse(await readFile(path.join(publication.dataDir, "index.json"), "utf8"));
const issue = index.latest
  ? JSON.parse(await readFile(path.join(publication.dataDir, "compiled", `${index.latest}.json`), "utf8"))
  : null;
const site = JSON.parse(await readFile(path.join(publication.configDir, "site.json"), "utf8"));
const template = await readFile(path.join(rootDir, "index.html"), "utf8");
await writeFile(
  path.join(outputDir, "index.html"),
  renderBuiltHtml(template, { activeTheme, issue, site }),
  "utf8",
);
await cp(path.join(rootDir, "public"), outputDir, { recursive: true });
await mkdir(path.join(outputDir, "themes"), { recursive: true });
if (activeTheme) {
  await cp(path.join(publication.themeSelectionDir, "active.json"), path.join(outputDir, "themes", "active.json"));
}
for (const entry of ["compiled", "previews"]) {
  await cp(
    path.join(rootDir, "themes", entry),
    path.join(outputDir, "themes", entry),
    { recursive: true },
  );
}

console.log(`静态站点已生成：${path.relative(rootDir, outputDir)}/`);
