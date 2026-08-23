import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "./lib/site-builder.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { outputDir } = await buildSite(rootDir);

console.log(`静态站点已生成：${path.relative(rootDir, outputDir)}/`);
