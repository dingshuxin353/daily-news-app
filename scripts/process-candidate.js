import path from "node:path";
import { fileURLToPath } from "node:url";
import { processCandidate } from "./lib/pipeline.js";

function parseArguments(args) {
  const options = { mode: "update", allowHistory: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--candidate") options.candidate = args[++index];
    else if (argument === "--publication") options.publicationId = args[++index];
    else if (argument === "--mode") options.mode = args[++index];
    else if (argument === "--allow-history") options.allowHistory = true;
    else throw new Error(`未知参数：${argument}`);
  }
  if (!options.candidate) throw new Error("缺少 --candidate 参数");
  if (!options.publicationId) throw new Error("缺少 --publication 参数");
  return options;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let publicationId = null;
try {
  const options = parseArguments(process.argv.slice(2));
  publicationId = options.publicationId;
  const result = await processCandidate(
    rootDir,
    options.publicationId,
    path.resolve(options.candidate),
    options,
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({
    result: "rejected",
    publicationId,
    date: error.date ?? null,
    field: error.field ?? null,
    reason: error.message,
  }));
  process.exitCode = 1;
}
