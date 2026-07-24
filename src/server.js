import { createServer } from "node:http";
import { URL } from "node:url";
import { buildDailyReport } from "./estimate.js";

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  response.end(status === 204 ? undefined : JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 100_000) throw new Error("Request body exceeds 100 KB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function localToday() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}

function isEvent(value) {
  return typeof value === "object" && value !== null &&
    (value.type === "chat_turn" || value.type === "git_commit") &&
    typeof value.id === "string" && typeof value.timestamp === "string";
}

export function createCollectorServer(options) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        sendJson(response, 204, {});
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "shadowbill", version: "0.1.0" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/events") {
        const event = await readJson(request);
        if (!isEvent(event)) {
          sendJson(response, 400, { error: "Invalid Shadowbill event" });
          return;
        }
        const inserted = await options.store.append(event);
        sendJson(response, 202, { accepted: true, duplicate: !inserted, id: event.id });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/report") {
        const events = await options.store.readAll();
        const date = url.searchParams.get("date") ?? localToday();
        sendJson(response, 200, buildDailyReport(events, date, options.pricing, options.profile));
        return;
      }

      sendJson(response, 404, { error: "Route not found" });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}
