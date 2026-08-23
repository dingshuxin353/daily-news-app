import path from "node:path";
import { fileURLToPath } from "node:url";

import { processTodoCandidate } from "./lib/todo-pipeline.js";

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--candidate") options.candidate = args[++index];
    else throw new Error(`未知参数：${argument}`);
  }
  if (!options.candidate) throw new Error("缺少 --candidate 参数");
  return options;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const options = parseArguments(process.argv.slice(2));
  const result = await processTodoCandidate(rootDir, path.resolve(options.candidate));
  console.log(JSON.stringify(result));
  if (result.result === "rejected") process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({
    result: error.result ?? "rejected",
    field: error.field ?? null,
    reason: error.message,
  }));
  process.exitCode = 1;
}
