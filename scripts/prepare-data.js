import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileIssue, formatWarning } from "./lib/compiler.js";
import { validateSources } from "./lib/validation.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const { site, index, issues } = await validateSources(rootDir);
  const results = issues.map(({ issue, filePath }) => (
    compileIssue(issue, filePath, site.priorityLimits)
  ));
  const compiledDir = path.join(rootDir, "data", "compiled");
  await rm(compiledDir, { recursive: true, force: true });
  await mkdir(compiledDir, { recursive: true });

  for (const { compiled, warnings } of results) {
    const compiledPath = path.join(compiledDir, `${compiled.date}.json`);
    await writeFile(compiledPath, `${JSON.stringify(compiled, null, 2)}\n`, "utf8");
    warnings.forEach((warning) => console.warn(formatWarning(warning)));
  }

  const indexPath = path.join(rootDir, "data", "index.json");
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  console.log(`数据校验与版面编译通过，已生成 data/compiled/ 和 ${path.relative(rootDir, indexPath)}（${index.dates.length} 期）`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
