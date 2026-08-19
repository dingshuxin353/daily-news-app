import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "dist");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const entry of ["index.html", "styles.css", "src", "config", "data"]) {
  await cp(path.join(rootDir, entry), path.join(outputDir, entry), { recursive: true });
}
await cp(path.join(rootDir, "public"), outputDir, { recursive: true });

console.log(`静态站点已生成：${path.relative(rootDir, outputDir)}/`);
