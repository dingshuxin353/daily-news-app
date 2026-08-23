import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderBuiltHtml, renderHomeHtml } from "./build-html.js";
import { buildHomeOverview, resolveHomeTheme, validateHomeProfile } from "./home.js";
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

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function replaceOutput(stagingDir, outputDir) {
  const backupDir = `${outputDir}.${randomUUID()}.backup`;
  const hadOutput = await pathExists(outputDir);
  if (hadOutput) await rename(outputDir, backupDir);
  try {
    await rename(stagingDir, outputDir);
  } catch (error) {
    if (hadOutput) await rename(backupDir, outputDir);
    throw error;
  }
  if (hadOutput) await rm(backupDir, { recursive: true, force: true });
}

export async function buildSite(rootDir, outputDir = path.join(rootDir, "dist"), options = {}) {
  const registry = await loadPublicationRegistry(rootDir);
  const home = await validateHomeProfile(rootDir);
  const homeTheme = await resolveHomeTheme(rootDir, home);
  const template = await readFile(path.join(rootDir, "index.html"), "utf8");
  const homeTemplate = await readFile(path.join(rootDir, "home.html"), "utf8");
  const publications = [];
  for (const publication of registry.publications) {
    const site = JSON.parse(await readFile(path.join(publication.configDir, "site.json"), "utf8"));
    publications.push({
      id: publication.publicationId,
      name: site.name,
      pageUrl: `/p/${publication.publicationId}/`,
    });
  }

  const publicationBuilds = [];
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
    publicationBuilds.push({ publication, activeTheme, issue, site });
  }
  const overview = home.enabled
    ? await buildHomeOverview(rootDir, registry, { asOfDate: options.asOfDate })
    : null;

  const resolvedOutput = path.resolve(outputDir);
  const stagingDir = path.join(
    path.dirname(resolvedOutput),
    `.${path.basename(resolvedOutput)}.${randomUUID()}.tmp`,
  );
  await mkdir(stagingDir, { recursive: false });
  try {
  for (const entry of ["styles.css", "src"]) {
    await cp(path.join(rootDir, entry), path.join(stagingDir, entry), { recursive: true });
  }
  await cp(path.join(rootDir, "public"), stagingDir, { recursive: true });
  await mkdir(path.join(stagingDir, "config"), { recursive: true });
  await cp(
    path.join(rootDir, "config", "publications.json"),
    path.join(stagingDir, "config", "publications.json"),
  );
  await mkdir(path.join(stagingDir, "themes"), { recursive: true });
  for (const entry of ["compiled", "previews"]) {
    await cp(
      path.join(rootDir, "themes", entry),
      path.join(stagingDir, "themes", entry),
      { recursive: true },
    );
  }

  for (const { publication, activeTheme, issue, site } of publicationBuilds) {
    const publicationOutput = await copyPublicationAssets(publication, stagingDir);
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

  if (home.enabled) {
    await mkdir(path.join(stagingDir, "home", "data"), { recursive: true });
    await mkdir(path.join(stagingDir, "home", "themes"), { recursive: true });
    await writeFile(
      path.join(stagingDir, "home", "data", "overview.json"),
      `${JSON.stringify(overview, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(stagingDir, "home", "themes", "active.json"),
      `${JSON.stringify(homeTheme, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(stagingDir, "index.html"),
      renderHomeHtml(homeTemplate, { activeTheme: homeTheme, home, overview, publications }),
      "utf8",
    );
  } else {
    await writeFile(
      path.join(stagingDir, "index.html"),
      redirectHtml(registry.defaultPublicationId),
      "utf8",
    );
  }
  await replaceOutput(stagingDir, resolvedOutput);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return { outputDir: resolvedOutput, registry, publications, home, overview };
}
