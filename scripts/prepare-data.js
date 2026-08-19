import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAll } from "./lib/validation.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const index = await validateAll(rootDir);
  const indexPath = path.join(rootDir, "data", "index.json");
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  console.log(`数据校验通过，已生成 ${path.relative(rootDir, indexPath)}（${index.dates.length} 期）`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
