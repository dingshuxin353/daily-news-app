import path from "node:path";
import { fileURLToPath } from "node:url";

import { rollbackTheme } from "./lib/theme-pipeline.js";
import { loadPublicationContext } from "./lib/publications.js";

const args = process.argv.slice(2);
try {
  const publicationIndex = args.indexOf("--publication");
  const publicationId = publicationIndex >= 0 ? args[publicationIndex + 1] : null;
  if (!publicationId) throw new Error("缺少 --publication 参数");
  const remaining = args.filter((_, index) => index !== publicationIndex && index !== publicationIndex + 1);
  if (remaining.length !== 1 || remaining[0] !== "--confirm") {
    throw new Error("必须使用 --confirm 明确确认回滚");
  }
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const publication = await loadPublicationContext(rootDir, publicationId);
  const result = await rollbackTheme(rootDir, {
    confirm: true,
    storageRoot: publication.publicationDir,
  });
  console.log(JSON.stringify({ ...result, publicationId: publication.publicationId }));
} catch (error) {
  console.log(JSON.stringify({ result: "rejected", field: error.field ?? null, reason: error.message }));
  process.exitCode = 1;
}
