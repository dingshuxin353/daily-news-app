import path from "node:path";
import { fileURLToPath } from "node:url";
import { processCandidate } from "./lib/pipeline.js";

function parseArguments(args) {
  const options = { mode: "update", allowHistory: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--candidate") options.candidate = args[++index];
    else if (argument === "--mode") options.mode = args[++index];
    else if (argument === "--allow-history") options.allowHistory = true;
    else throw new Error(`未知参数：${argument}`);
  }
  if (!options.candidate) throw new Error("缺少 --candidate 参数");
  return options;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const options = parseArguments(process.argv.slice(2));
  const result = await processCandidate(rootDir, path.resolve(options.candidate), options);
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({
    result: "rejected",
    date: error.date ?? null,
    field: error.field ?? null,
    reason: error.message,
  }));
  process.exitCode = 1;
}
