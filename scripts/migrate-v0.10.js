import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyV010Migration, createV010MigrationPlan } from "./lib/migration-v0.10.js";

function parseArguments(args) {
  const options = { apply: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--home-enabled") {
      const value = args[++index];
      if (value !== "true" && value !== "false") throw new Error("--home-enabled 必须是 true 或 false");
      options.enabled = value === "true";
    } else if (args[index] === "--name") options.name = args[++index];
    else if (args[index] === "--accent") options.accentColor = args[++index];
    else if (args[index] === "--apply") options.apply = true;
    else if (args[index] === "--confirm") options.confirm = args[++index];
    else throw new Error(`未知参数：${args[index]}`);
  }
  return options;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const options = parseArguments(process.argv.slice(2));
  const plan = await createV010MigrationPlan(rootDir, options);
  const result = options.apply
    ? await applyV010Migration(rootDir, plan, { confirm: options.confirm })
    : { result: "migration-plan", plan };
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(JSON.stringify({ result: "rejected", field: error.field ?? null, reason: error.message }));
  process.exitCode = 1;
}
