import path from "node:path";
import { fileURLToPath } from "node:url";

import { listThemes } from "./lib/theme-pipeline.js";
import { loadPublicationContext } from "./lib/publications.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--publication") {
    throw new Error("缺少 --publication 参数");
  }
  const publication = await loadPublicationContext(rootDir, args[1]);
  const result = await listThemes(rootDir, publication.publicationDir);
  console.log(JSON.stringify({ ...result, publicationId: publication.publicationId }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ result: "rejected", field: error.field ?? null, reason: error.message }));
  process.exitCode = 1;
}
