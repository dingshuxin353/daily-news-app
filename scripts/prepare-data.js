import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileIssue, formatWarning } from "./lib/compiler.js";
import { loadPublicationRegistry } from "./lib/publications.js";
import { validateSources } from "./lib/validation.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const registry = await loadPublicationRegistry(rootDir);
  for (const publication of registry.publications) {
    const { site, index, issues } = await validateSources(rootDir, publication.publicationDir);
    const results = issues.map(({ issue, filePath }) => (
      compileIssue(issue, filePath, site.priorityLimits)
    ));
    const compiledDir = path.join(publication.dataDir, "compiled");
    await mkdir(compiledDir, { recursive: true });
    const compiledNames = await readdir(compiledDir);
    await Promise.all(
      compiledNames
        .filter((name) => name.endsWith(".json"))
        .map((name) => unlink(path.join(compiledDir, name))),
    );

    for (const { compiled, warnings } of results) {
      const compiledPath = path.join(compiledDir, `${compiled.date}.json`);
      await writeFile(compiledPath, `${JSON.stringify(compiled, null, 2)}\n`, "utf8");
      warnings.forEach((warning) => console.warn(formatWarning(warning)));
    }

    const indexPath = path.join(publication.dataDir, "index.json");
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    console.log(
      `${publication.publicationId}: 数据校验与版面编译通过（${index.dates.length} 期）`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
