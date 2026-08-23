import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrateV09 } from "./lib/migration.js";

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--publication") options.publicationId = args[++index];
    else if (argument === "--confirm") options.confirmation = args[++index];
    else throw new Error(`未知参数：${argument}`);
  }
  if (!options.publicationId) throw new Error("缺少 --publication 参数");
  if (!options.confirmation) throw new Error("缺少 --confirm 参数");
  return options;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const options = parseArguments(process.argv.slice(2));
  console.log(JSON.stringify(await migrateV09(
    rootDir,
    options.publicationId,
    options.confirmation,
  )));
} catch (error) {
  console.log(JSON.stringify({ result: "rejected", reason: error.message }));
  process.exitCode = 1;
}
