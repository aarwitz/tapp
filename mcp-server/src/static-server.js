// Minimal owned-repository static server used only by managed `tapp init
// --explore` when no project start script exists. Paths are resolved beneath
// the explicit root and no directory listing or mutation is supported.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = fs.realpathSync(path.resolve(process.argv[2] || "."));
const port = Number(process.argv[3]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("static server port must be 1..65535");

const types = new Map([
  [".css", "text/css; charset=utf-8"], [".gif", "image/gif"], [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"], [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"], [".png", "image/png"],
  [".svg", "image/svg+xml"], [".txt", "text/plain; charset=utf-8"], [".webp", "image/webp"], [".woff2", "font/woff2"],
]);

function ownedPath(url) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(url || "/", "http://127.0.0.1").pathname); }
  catch { return null; }
  const relative = pathname.replace(/^\/+/, "");
  let candidate = path.resolve(root, relative || "index.html");
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  try {
    if (fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, "index.html");
  } catch {}
  return candidate;
}

const server = http.createServer((request, response) => {
  const candidate = ownedPath(request.url);
  if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": types.get(path.extname(candidate).toLowerCase()) || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(candidate).pipe(response);
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
