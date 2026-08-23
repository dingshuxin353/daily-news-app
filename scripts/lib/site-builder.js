import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderBuiltHtml } from "./build-html.js";
import { loadPublicationRegistry } from "./publications.js";
import { validateConfiguredTheme } from "./theme-pipeline.js";

function redirectHtml(publicationId) {
  const target = `/p/${publicationId}/`;
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="0; url=${target}">
    <title>DailyNews</title>
  </head>
  <body>
    <p>正在进入默认日报。<a href="${target}">继续</a></p>
    <script>location.replace(${JSON.stringify(target)});</script>
  </body>
</html>
`;
}

async function copyPublicationAssets(publication, outputDir) {
  const publicationOutput = path.join(outputDir, "p", publication.publicationId);
  await mkdir(path.join(publicationOutput, "config"), { recursive: true });
  await mkdir(path.join(publicationOutput, "data"), { recursive: true });
  await mkdir(path.join(publicationOutput, "themes"), { recursive: true });
  for (const name of ["site.json", "theme.json"]) {
    await cp(path.join(publication.configDir, name), path.join(publicationOutput, "config", name));
  }
  await cp(
    path.join(publication.dataDir, "compiled"),
    path.join(publicationOutput, "data", "compiled"),
    { recursive: true },
  );
  await cp(
    path.join(publication.dataDir, "submissions"),
    path.join(publicationOutput, "data", "submissions"),
    { recursive: true },
  );
  const compiledNames = await readdir(path.join(publication.dataDir, "compiled"));
  const submissionOutput = path.join(publicationOutput, "data", "submissions");
  const submissionNames = new Set(await readdir(submissionOutput));
  for (const name of ["latest.json", ...compiledNames.filter((entry) => entry.endsWith(".json"))]) {
    if (!submissionNames.has(name)) await writeFile(path.join(submissionOutput, name), "null\n");
  }
  await cp(
    path.join(publication.dataDir, "index.json"),
    path.join(publicationOutput, "data", "index.json"),
  );
  await cp(
    path.join(publication.themeSelectionDir, "active.json"),
    path.join(publicationOutput, "themes", "active.json"),
  );
  return publicationOutput;
}

export async function buildSite(rootDir, outputDir = path.join(rootDir, "dist")) {
  const registry = await loadPublicationRegistry(rootDir);
  const template = await readFile(path.join(rootDir, "index.html"), "utf8");
  const publications = [];
  for (const publication of registry.publications) {
    const site = JSON.parse(await readFile(path.join(publication.configDir, "site.json"), "utf8"));
    publications.push({
      id: publication.publicationId,
      name: site.name,
      pageUrl: `/p/${publication.publicationId}/`,
    });
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  for (const entry of ["styles.css", "src"]) {
    await cp(path.join(rootDir, entry), path.join(outputDir, entry), { recursive: true });
  }
  await cp(path.join(rootDir, "public"), outputDir, { recursive: true });
  await mkdir(path.join(outputDir, "config"), { recursive: true });
  await cp(
    path.join(rootDir, "config", "publications.json"),
    path.join(outputDir, "config", "publications.json"),
  );
  await mkdir(path.join(outputDir, "themes"), { recursive: true });
  for (const entry of ["compiled", "previews"]) {
    await cp(
      path.join(rootDir, "themes", entry),
      path.join(outputDir, "themes", entry),
      { recursive: true },
    );
  }

  for (const publication of registry.publications) {
    const activeTheme = await validateConfiguredTheme(rootDir, publication.publicationDir);
    const index = JSON.parse(await readFile(path.join(publication.dataDir, "index.json"), "utf8"));
    const issue = index.latest
      ? JSON.parse(await readFile(
        path.join(publication.dataDir, "compiled", `${index.latest}.json`),
        "utf8",
      ))
      : null;
    const site = JSON.parse(await readFile(path.join(publication.configDir, "site.json"), "utf8"));
    const publicationOutput = await copyPublicationAssets(publication, outputDir);
    await writeFile(
      path.join(publicationOutput, "index.html"),
      renderBuiltHtml(template, {
        activeTheme,
        issue,
        site,
        publicationId: publication.publicationId,
        publications,
      }),
      "utf8",
    );
  }

  await writeFile(path.join(outputDir, "index.html"), redirectHtml(registry.defaultPublicationId), "utf8");
  return { outputDir, registry, publications };
}
