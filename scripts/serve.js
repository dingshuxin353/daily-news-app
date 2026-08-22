import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staticRoot = path.join(projectRoot, "dist");
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function resolveRequestPath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  if (decoded === "/") return path.join(staticRoot, "index.html");
  return path.join(staticRoot, decoded);
}

createServer(async (request, response) => {
  let filePath;
  try {
    filePath = resolveRequestPath(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  if (!filePath.startsWith(`${staticRoot}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    if (!(await stat(filePath)).isFile()) throw new Error();
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(filePath)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`DailyNews 已启动：http://127.0.0.1:${port}`);
});
