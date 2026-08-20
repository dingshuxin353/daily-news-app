import path from "node:path";
import { fileURLToPath } from "node:url";

import { rollbackTheme } from "./lib/theme-pipeline.js";

const args = process.argv.slice(2);
try {
  if (args.length !== 1 || args[0] !== "--confirm") {
    throw new Error("必须使用 --confirm 明确确认回滚");
  }
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(JSON.stringify(await rollbackTheme(rootDir, { confirm: true })));
} catch (error) {
  console.log(JSON.stringify({ result: "rejected", field: error.field ?? null, reason: error.message }));
  process.exitCode = 1;
}
