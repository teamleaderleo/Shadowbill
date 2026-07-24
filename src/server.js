import { createServer } from "node:http";
import { URL } from "node:url";
import { buildDailyReport, dateInTimeZone } from "./estimate.js";
import { normalizeGitHubWebhook, verifyGitHubSignature } from "./github.js";

const EVENT_TYPES = new Set([
  "chat_turn",
  "git_commit",
  "github_push",
  "github_pull_request",
  "github_workflow_run",
  "github_deployment",
]);

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-github-event,x-github-delivery,x-hub-signature-256",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  response.end(status === 204 ? undefined : JSON.stringify(value));
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error(`Request body exceeds ${maximumBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function isEvent(value) {
  return typeof value === "object" && value !== null && EVENT_TYPES.has(value.type) &&
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp));
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
        sendJson(response, 200, { ok: true, service: "shadowbill", version: "0.2.0" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/events") {
        const body = await readBody(request, 100_000);
        const event = parseJson(body);
        if (!isEvent(event)) {
          sendJson(response, 400, { error: "Invalid Shadowbill event" });
          return;
        }
        const inserted = await options.store.append(event);
        sendJson(response, 202, { accepted: true, duplicate: !inserted, id: event.id });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/github/webhooks") {
        if (!options.githubWebhookSecret) {
          sendJson(response, 503, { error: "GitHub webhook ingestion requires a configured secret" });
          return;
        }

        const body = await readBody(request, 2_000_000);
        const signature = request.headers["x-hub-signature-256"];
        if (!verifyGitHubSignature(body, Array.isArray(signature) ? signature[0] : signature, options.githubWebhookSecret)) {
          sendJson(response, 401, { error: "Invalid GitHub webhook signature" });
          return;
        }

        const eventNameHeader = request.headers["x-github-event"];
        const deliveryHeader = request.headers["x-github-delivery"];
        const eventName = Array.isArray(eventNameHeader) ? eventNameHeader[0] : eventNameHeader;
        const deliveryId = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;
        if (!eventName || !deliveryId) {
          sendJson(response, 400, { error: "Missing GitHub event or delivery header" });
          return;
        }

        const payload = parseJson(body);
        if (!payload) {
          sendJson(response, 400, { error: "Invalid GitHub webhook JSON" });
          return;
        }

        const event = normalizeGitHubWebhook(eventName, deliveryId, payload);
        if (!event) {
          sendJson(response, 202, { accepted: false, ignored: true, event: eventName });
          return;
        }

        const inserted = await options.store.append(event);
        sendJson(response, 202, { accepted: true, duplicate: !inserted, id: event.id });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/report") {
        const events = await options.store.readAll();
        const timeZone = url.searchParams.get("timezone") ?? options.timeZone;
        const date = url.searchParams.get("date") ?? dateInTimeZone(new Date().toISOString(), timeZone);
        sendJson(response, 200, buildDailyReport(events, date, options.pricing, options.profile, timeZone));
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
