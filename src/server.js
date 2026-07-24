import { createServer } from "node:http";
import { URL } from "node:url";
import { verifyBearerAuthorization } from "./auth.js";
import { buildDailyReport, dateInTimeZone } from "./estimate.js";
import { normalizeGitHubWebhook, verifyGitHubSignature } from "./github.js";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max", "unknown"]);

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization,content-type,x-github-event,x-github-delivery,x-hub-signature-256",
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
    if (size > maximumBytes) throw new HttpError(413, `Request body exceeds ${maximumBytes} bytes`);
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

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeBrowserChatEvent(value) {
  if (!value || typeof value !== "object" || value.type !== "chat_turn") return null;
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id)) return null;
  if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) return null;
  if (typeof value.conversationHash !== "string" || !/^[a-f0-9]{16,128}$/i.test(value.conversationHash)) return null;
  if (typeof value.model !== "string" || value.model.length < 1 || value.model.length > 100) return null;
  if (!REASONING_EFFORTS.has(value.reasoningEffort)) return null;
  if (!safeInteger(value.visibleInputTokens) || !safeInteger(value.visibleOutputTokens)) return null;
  if (value.toolActivityCount !== undefined && !safeInteger(value.toolActivityCount)) return null;
  if (value.responseDurationMs !== undefined && !safeInteger(value.responseDurationMs)) return null;
  if (value.collectorVersion !== undefined && (typeof value.collectorVersion !== "string" || value.collectorVersion.length > 50)) return null;

  return {
    type: "chat_turn",
    id: value.id,
    timestamp: new Date(value.timestamp).toISOString(),
    conversationHash: value.conversationHash.toLowerCase(),
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    visibleInputTokens: value.visibleInputTokens,
    visibleOutputTokens: value.visibleOutputTokens,
    ...(value.toolActivityCount === undefined ? {} : { toolActivityCount: value.toolActivityCount }),
    ...(value.responseDurationMs === undefined ? {} : { responseDurationMs: value.responseDurationMs }),
    ...(value.collectorVersion === undefined ? {} : { collectorVersion: value.collectorVersion }),
  };
}

function authorizationHeader(request) {
  const value = request.headers.authorization;
  return Array.isArray(value) ? value[0] : value;
}

function authorizeCollector(request, response, token) {
  if (!token) {
    sendJson(response, 503, { error: "Browser event ingestion requires a collector token" });
    return false;
  }
  if (!verifyBearerAuthorization(authorizationHeader(request), token)) {
    sendJson(response, 401, { error: "Invalid collector token" });
    return false;
  }
  return true;
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
        sendJson(response, 200, { ok: true, service: "shadowbill", version: "0.2.1" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/auth/check") {
        if (!authorizeCollector(request, response, options.collectorToken)) return;
        sendJson(response, 200, { authenticated: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/events") {
        if (!authorizeCollector(request, response, options.collectorToken)) return;
        const body = await readBody(request, 100_000);
        const event = normalizeBrowserChatEvent(parseJson(body));
        if (!event) {
          sendJson(response, 400, { error: "Invalid aggregate chat event" });
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

        let event;
        try {
          event = normalizeGitHubWebhook(eventName, deliveryId, payload);
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
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
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
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
