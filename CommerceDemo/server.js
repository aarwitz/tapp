import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4190);
const fault = process.env.COMMERCE_DEMO_FAULT || "";
let orders = [];
let nextOrder = 1001;

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "POST" && url.pathname === "/__tapp/reset") {
      orders = [];
      nextOrder = 1001;
      return json(response, 200, { reset: true });
    }
    if (request.method === "POST" && url.pathname === "/api/orders") {
      const input = await body(request);
      if (!String(input.product || "").trim()) return json(response, 422, { error: "product required" });
      const order = { id: `TAPP-${nextOrder++}`, product: String(input.product).trim() };
      orders.push(order);
      return json(response, 201, { order });
    }
    if (request.method === "GET" && url.pathname === "/api/orders") {
      return json(response, 200, { orders: fault === "drop-order-history" ? [] : orders });
    }
    const routes = new Set(["/", "/cart", "/checkout", "/confirmation", "/orders"]);
    const file = routes.has(url.pathname) ? "index.html" : url.pathname.slice(1);
    if (!["index.html", "app.js", "styles.css"].includes(file)) return json(response, 404, { error: "not found" });
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
    response.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
    fs.createReadStream(path.join(root, file)).pipe(response);
  } catch (error) {
    json(response, 500, { error: error.message || String(error) });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Tapp CommerceDemo listening on http://127.0.0.1:${port} (fault=${fault || "none"})`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
