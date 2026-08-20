import path from "node:path";
import { fileURLToPath } from "node:url";

import { processTheme } from "./lib/theme-pipeline.js";

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--candidate") options.candidate = args[++index];
    else throw new Error(`未知参数：${args[index]}`);
  }
  if (!options.candidate) throw new Error("缺少 --candidate 参数");
  return options;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const options = parseArguments(process.argv.slice(2));
  console.log(JSON.stringify(await processTheme(rootDir, path.resolve(options.candidate))));
} catch (error) {
  console.log(JSON.stringify({
    result: "rejected",
    field: error.field ?? null,
    reason: error.message,
  }));
  process.exitCode = 1;
}
