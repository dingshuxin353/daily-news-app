import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../.cloud-dist/", import.meta.url));

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`));
    });
  });
}

await rm(outputDirectory, { recursive: true, force: true });
await run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.cloud.json"]);
await run(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "vite.config.ts", "--mode", "client"]);
await run(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "vite.config.ts", "--mode", "server"]);
