import { createServer } from "node:http";
import { URL } from "node:url";
import { verifyBearerAuthorization } from "./auth.js";
import { dashboardResponse, isDashboardPath } from "./dashboard.js";
import { buildDailyReport, dateInTimeZone } from "./estimate.js";
import { buildFleetProjection } from "./fleet-projection.js";
import { normalizeGitHubWebhook, verifyGitHubSignature } from "./github.js";
import { browserCorsHeaders, isAllowedHost, normalizeAllowedHosts } from "./http-security.js";
import { buildRevisionProjection } from "./inspect-projection.js";
import { buildRangeReport, calendarDateRange } from "./range.js";
import { buildRepositoryAllocationReport } from "./repositories.js";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max", "unknown"]);
const BROWSER_EVENT_ID = /^chat_[a-f0-9]{24}$/i;
const CONVERSATION_HASH = /^[a-f0-9]{24}$/i;
const LOGICAL_TURN_HASH = /^[a-f0-9]{24}$/i;
const MODEL_SLUG = /^[a-z0-9][a-z0-9._:-]{0,99}$/i;
const COLLECTOR_VERSION = /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i;
const PROJECTION_REPOSITORY = /^[a-z0-9](?:[a-z0-9._-]{0,99})\/[a-z0-9](?:[a-z0-9._-]{0,99})$/u;
const PROJECTION_REVISION = /^[a-f0-9]{40}$/u;

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(status === 204 ? undefined : JSON.stringify(value));
}

function sendAsset(request, response, asset) {
  response.writeHead(asset.status, asset.headers);
  response.end(request.method === "HEAD" ? undefined : asset.body);
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

function parseDays(value) {
  if (value === null) return 1;
  if (!/^\d+$/.test(value)) throw new HttpError(400, "days must be an integer between 1 and 365");
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new HttpError(400, "days must be an integer between 1 and 365");
  }
  return days;
}

function validateTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new HttpError(400, "timezone must be a valid IANA timezone");
  }
}

function normalizeBrowserChatEvent(value) {
  if (!value || typeof value !== "object" || value.type !== "chat_turn") return null;
  if (typeof value.id !== "string" || !BROWSER_EVENT_ID.test(value.id)) return null;
  if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) return null;
  if (typeof value.conversationHash !== "string" || !CONVERSATION_HASH.test(value.conversationHash)) return null;
  if (typeof value.model !== "string" || !MODEL_SLUG.test(value.model)) return null;
  if (!REASONING_EFFORTS.has(value.reasoningEffort)) return null;
  if (!safeInteger(value.visibleInputTokens) || !safeInteger(value.visibleOutputTokens)) return null;
  if (value.toolActivityCount !== undefined && !safeInteger(value.toolActivityCount)) return null;
  if (value.responseDurationMs !== undefined && !safeInteger(value.responseDurationMs)) return null;
  if (value.collectorVersion !== undefined &&
      (typeof value.collectorVersion !== "string" || !COLLECTOR_VERSION.test(value.collectorVersion))) return null;

  const hasRevisionFields = value.logicalTurnHash !== undefined || value.capturedAt !== undefined;
  if (hasRevisionFields) {
    if (typeof value.logicalTurnHash !== "string" || !LOGICAL_TURN_HASH.test(value.logicalTurnHash)) return null;
    if (typeof value.capturedAt !== "string" || Number.isNaN(Date.parse(value.capturedAt))) return null;
  }

  return {
    type: "chat_turn",
    id: value.id.toLowerCase(),
    timestamp: new Date(value.timestamp).toISOString(),
    ...(hasRevisionFields ? {
      capturedAt: new Date(value.capturedAt).toISOString(),
      logicalTurnHash: value.logicalTurnHash.toLowerCase(),
    } : {}),
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

function authorizeCollector(request, response, token, headers) {
  if (!token) {
    sendJson(response, 503, { error: "Browser event ingestion requires a collector token" }, headers);
    return false;
  }
  if (!verifyBearerAuthorization(authorizationHeader(request), token)) {
    sendJson(response, 401, { error: "Invalid collector token" }, headers);
    return false;
  }
  return true;
}

function projectionError(error, command) {
  const code = typeof error?.code === "string" ? error.code : "PROJECTION_HTTP_FAILED";
  const status = code === "PROJECTION_REPOSITORY_UNKNOWN"
    ? 404
    : code === "PROJECTION_REPOSITORY_REQUIRED" || code === "PROJECTION_INVALID_REVISION"
      ? 400
      : 500;
  return {
    status,
    value: {
      service: "proofwake",
      command,
      status: "error",
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    },
  };
}

export function createCollectorServer(options) {
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);

  return createServer(async (request, response) => {
    let routeHeaders = {};
    try {
      const hostHeader = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
      if (!isAllowedHost(hostHeader, allowedHosts)) {
        sendJson(response, 421, { error: "Unapproved Host header" });
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      routeHeaders = browserCorsHeaders(url.pathname);

      if ((request.method === "GET" || request.method === "HEAD") && isDashboardPath(url.pathname)) {
        sendAsset(request, response, await dashboardResponse(url.pathname));
        return;
      }

      if (request.method === "OPTIONS") {
        if (Object.keys(routeHeaders).length === 0) {
          sendJson(response, 404, { error: "Route not found" });
          return;
        }
        sendJson(response, 204, {}, routeHeaders);
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "proofwake", version: "0.3.0" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/fleet") {
        if (!options.registryStore) {
          sendJson(response, 503, {
            service: "proofwake",
            command: "fleet",
            status: "error",
            error: { code: "PROJECTION_REGISTRY_UNAVAILABLE", message: "Repository registry is unavailable." },
          });
          return;
        }
        try {
          const report = await buildFleetProjection({
            registryStore: options.registryStore,
            eventStore: options.store,
            now: new Date(),
          });
          sendJson(response, 200, report);
        } catch (error) {
          const failure = projectionError(error, "fleet");
          sendJson(response, failure.status, failure.value);
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/revision-evidence") {
        if (!options.registryStore) {
          sendJson(response, 503, {
            service: "proofwake",
            command: "inspect",
            status: "error",
            error: { code: "PROJECTION_REGISTRY_UNAVAILABLE", message: "Repository registry is unavailable." },
          });
          return;
        }
        const repository = url.searchParams.get("repository")?.toLowerCase() ?? "";
        const revision = url.searchParams.get("revision") ?? undefined;
        if (!PROJECTION_REPOSITORY.test(repository)) {
          sendJson(response, 400, {
            service: "proofwake",
            command: "inspect",
            status: "error",
            error: { code: "PROJECTION_REPOSITORY_REQUIRED", message: "repository must use canonical owner/name form." },
          });
          return;
        }
        if (revision !== undefined && !PROJECTION_REVISION.test(revision)) {
          sendJson(response, 400, {
            service: "proofwake",
            command: "inspect",
            status: "error",
            error: { code: "PROJECTION_INVALID_REVISION", message: "revision must be a full lowercase SHA-1." },
          });
          return;
        }
        try {
          const report = await buildRevisionProjection({
            repository,
            revision,
            registryStore: options.registryStore,
            eventStore: options.store,
            now: new Date(),
          });
          sendJson(response, 200, report);
        } catch (error) {
          const failure = projectionError(error, "inspect");
          sendJson(response, failure.status, failure.value);
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/auth/check") {
        if (!authorizeCollector(request, response, options.collectorToken, routeHeaders)) return;
        sendJson(response, 200, { authenticated: true }, routeHeaders);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/events") {
        if (!authorizeCollector(request, response, options.collectorToken, routeHeaders)) return;
        const body = await readBody(request, 100_000);
        const event = normalizeBrowserChatEvent(parseJson(body));
        if (!event) {
          sendJson(response, 400, { error: "Invalid aggregate chat event" }, routeHeaders);
          return;
        }
        const inserted = await options.store.append(event);
        sendJson(response, 202, { accepted: true, duplicate: !inserted, id: event.id }, routeHeaders);
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
        validateTimeZone(timeZone);
        const date = url.searchParams.get("date") ?? dateInTimeZone(new Date().toISOString(), timeZone);
        const days = parseDays(url.searchParams.get("days"));
        const group = url.searchParams.get("group");
        if (group !== null && group !== "repository") {
          throw new HttpError(400, "group must be repository when provided");
        }
        try {
          calendarDateRange(date, days);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        const report = group === "repository"
          ? buildRepositoryAllocationReport(events, date, days, options.pricing, options.profile, timeZone)
          : days === 1
            ? buildDailyReport(events, date, options.pricing, options.profile, timeZone)
            : buildRangeReport(events, date, days, options.pricing, options.profile, timeZone);
        sendJson(response, 200, report);
        return;
      }

      sendJson(response, 404, { error: "Route not found" });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { error: error instanceof Error ? error.message : String(error) }, routeHeaders);
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
