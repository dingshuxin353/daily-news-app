import path from "node:path";
import { fileURLToPath } from "node:url";

import { listThemes } from "./lib/theme-pipeline.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  if (process.argv.length > 2) throw new Error(`未知参数：${process.argv[2]}`);
  console.log(JSON.stringify(await listThemes(rootDir), null, 2));
} catch (error) {
  console.log(JSON.stringify({ result: "rejected", field: error.field ?? null, reason: error.message }));
  process.exitCode = 1;
}
