import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateIssue } from "./validation.js";

export async function writeIssue(rootDir, date, candidatePath) {
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(parsedDate.valueOf())
    || parsedDate.toISOString().slice(0, 10) !== date
  ) {
    throw new Error("目标日期必须是合法的 YYYY-MM-DD");
  }
  const source = await readFile(candidatePath);
  const issuesDir = path.join(rootDir, "data", "issues");
  const targetPath = path.join(issuesDir, `${date}.json`);
  const temporaryPath = path.join(issuesDir, `.${date}.${randomUUID()}.tmp`);

  await mkdir(issuesDir, { recursive: true });
  try {
    await writeFile(temporaryPath, source, { flag: "wx" });
    await validateIssue(temporaryPath, date);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return targetPath;
}
