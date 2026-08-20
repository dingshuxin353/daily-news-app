import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeIssue } from "./lib/writer.js";

const [date, candidatePath] = process.argv.slice(2);
if (!date || !candidatePath) {
  console.error("用法：npm run write-issue -- YYYY-MM-DD /path/to/candidate.json");
  process.exitCode = 1;
} else {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const targetPath = await writeIssue(rootDir, date, path.resolve(candidatePath));
    console.log(`日报校验通过并已安全写入：${path.relative(rootDir, targetPath)}`);
  } catch (error) {
    console.error(`日报未写入：${error.message}`);
    process.exitCode = 1;
  }
}
