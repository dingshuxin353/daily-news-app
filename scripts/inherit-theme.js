import path from "node:path";
import { fileURLToPath } from "node:url";

import { inheritTheme } from "./lib/theme-pipeline.js";
import { loadPublicationContext } from "./lib/publications.js";

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--publication") options.publicationId = args[++index];
    else if (args[index] === "--confirm") options.confirm = true;
    else throw new Error(`未知参数：${args[index]}`);
  }
  if (!options.publicationId) throw new Error("缺少 --publication 参数");
  return options;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const options = parseArguments(process.argv.slice(2));
  const publication = await loadPublicationContext(rootDir, options.publicationId);
  const result = await inheritTheme(rootDir, {
    confirm: options.confirm,
    storageRoot: publication.publicationDir,
  });
  console.log(JSON.stringify({ ...result, publicationId: publication.publicationId }));
} catch (error) {
  console.log(JSON.stringify({ result: "rejected", field: error.field ?? null, reason: error.message }));
  process.exitCode = 1;
}
