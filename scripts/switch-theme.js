import path from "node:path";
import { fileURLToPath } from "node:url";

import { switchTheme } from "./lib/theme-pipeline.js";

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--theme") options.theme = args[++index];
    else if (args[index] === "--revision") {
      const revision = args[++index];
      if (!/^[1-9]\d*$/.test(revision ?? "")) throw new Error("--revision 必须是大于等于 1 的整数");
      options.revision = Number(revision);
    } else if (args[index] === "--confirm") options.confirm = args[++index];
    else throw new Error(`未知参数：${args[index]}`);
  }
  if (!options.theme) throw new Error("缺少 --theme 参数");
  return options;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const options = parseArguments(process.argv.slice(2));
  console.log(JSON.stringify(await switchTheme(rootDir, options.theme, options)));
} catch (error) {
  console.log(JSON.stringify({ result: "rejected", field: error.field ?? null, reason: error.message }));
  process.exitCode = 1;
}
