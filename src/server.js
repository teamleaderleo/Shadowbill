import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { verifyBearerAuthorization } from "./auth.js";
import { dashboardResponse, isDashboardPath } from "./dashboard.js";
import { buildDailyReport, dateInTimeZone } from "./estimate.js";
import { buildFleetProjection } from "./fleet-projection.js";
import { mapGitHubWebhookObservation } from "./github-observation.js";
import { verifyGitHubSignature } from "./github.js";
import { buildFailureReport, buildRecoveryReport } from "./history-reports.js";
import { browserCorsHeaders, isAllowedHost, normalizeAllowedHosts } from "./http-security.js";
import { buildRevisionProjection } from "./inspect-projection.js";
import { ObservationLedger } from "./observation-ledger.js";
import { buildRangeReport, calendarDateRange } from "./range.js";
import { buildRepositoryAllocationReport } from "./repositories.js";
import { RepositoryRegistryStore } from "./repository-registry.js";

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
const GITHUB_EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const GITHUB_DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GITHUB_OBSERVATION_SOURCE = "urn:proofwake:provider:github";

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

function parseHistoryDays(url) {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "days") || url.searchParams.getAll("days").length > 1) {
    throw new Error("History report queries accept one days parameter.");
  }
  const value = url.searchParams.get("days");
  if (value === null) return 30;
  if (!/^\d+$/u.test(value)) throw new Error("days must be an integer between 1 and 365.");
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new Error("days must be an integer between 1 and 365.");
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

function historyError(command, code) {
  const message = code === "HISTORY_REPORT_REGISTRY_UNAVAILABLE"
    ? "Repository registry is unavailable."
    : code === "HISTORY_REPORT_INVALID_QUERY" || code === "HISTORY_REPORT_INVALID_DAYS"
      ? "History report query is invalid."
      : "History report generation failed.";
  return {
    service: "proofwake",
    command,
    status: "error",
    error: { code, message },
  };
}

function resolveRegistryStore(options) {
  if (options.registryStore !== undefined) return options.registryStore;
  if (typeof options.store?.path !== "string") return null;
  return new RepositoryRegistryStore(join(dirname(options.store.path), "repositories.json"));
}

function singleHeader(value) {
  return typeof value === "string" ? value : null;
}

function githubWebhookFailure(code, message) {
  return { accepted: false, error: { code, message } };
}

function boundedGitHubMappingError(error) {
  const code = typeof error?.code === "string" &&
      (error.code.startsWith("GITHUB_OBSERVATION_") || error.code.startsWith("ACTIVITY_OBSERVATION_"))
    ? error.code
    : "GITHUB_WEBHOOK_INVALID_PAYLOAD";
  return githubWebhookFailure(code, "GitHub webhook payload is invalid.");
}

function canonicalNow(options) {
  const value = typeof options.now === "function" ? options.now() : new Date();
  const time = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(time.getTime()) ? new Date().toISOString() : time.toISOString();
}

function githubObservationId(eventName, deliveryId) {
  return `github-${eventName}-${deliveryId}`;
}

function matchingGitHubObservation(events, eventName, deliveryId) {
  const id = githubObservationId(eventName, deliveryId);
  return events.find((entry) => entry?.type === "proofwake_observation" &&
    entry.observationIdentity?.source === GITHUB_OBSERVATION_SOURCE &&
    entry.observationIdentity?.id === id) ?? null;
}

async function canonicalGitHubReceivedAt(options, eventName, deliveryId) {
  const captured = canonicalNow(options);
  const events = await options.store.readAll();
  const existing = matchingGitHubObservation(events, eventName, deliveryId);
  const observedAt = existing?.observation?.data?.observedAt;
  return typeof observedAt === "string" && !Number.isNaN(Date.parse(observedAt)) ? observedAt : captured;
}

function sameGitHubDelivery(existing, observation) {
  const existingDigest = existing?.observation?.data?.evidence?.[0]?.digest;
  const candidateDigest = observation?.data?.evidence?.[0]?.digest;
  return typeof existingDigest === "string" && existingDigest === candidateDigest;
}

export function createCollectorServer(options) {
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const registryStore = resolveRegistryStore(options);

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
        if (!registryStore) {
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
            registryStore,
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
        if (!registryStore) {
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
            registryStore,
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

      if (request.method === "GET" && (url.pathname === "/v1/failures" || url.pathname === "/v1/recoveries")) {
        const command = url.pathname === "/v1/failures" ? "failures" : "recoveries";
        if (!registryStore) {
          sendJson(response, 503, historyError(command, "HISTORY_REPORT_REGISTRY_UNAVAILABLE"));
          return;
        }
        let days;
        try {
          days = parseHistoryDays(url);
        } catch {
          sendJson(response, 400, historyError(command, "HISTORY_REPORT_INVALID_QUERY"));
          return;
        }
        try {
          const now = new Date();
          const report = command === "failures"
            ? await buildFailureReport({ registryStore, eventStore: options.store, days, now })
            : await buildRecoveryReport({ registryStore, eventStore: options.store, days, now });
          sendJson(response, 200, report);
        } catch (error) {
          const code = typeof error?.code === "string" ? error.code : "HISTORY_REPORT_HTTP_FAILED";
          const status = code === "HISTORY_REPORT_INVALID_DAYS" ? 400 : 500;
          sendJson(response, status, historyError(command, code));
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
          sendJson(response, 503, githubWebhookFailure(
            "GITHUB_WEBHOOK_SECRET_REQUIRED",
            "GitHub webhook ingestion requires a configured secret.",
          ));
          return;
        }

        const body = await readBody(request, 2_000_000);
        const signature = singleHeader(request.headers["x-hub-signature-256"]);
        if (!verifyGitHubSignature(body, signature ?? undefined, options.githubWebhookSecret)) {
          sendJson(response, 401, githubWebhookFailure(
            "GITHUB_WEBHOOK_INVALID_SIGNATURE",
            "Invalid GitHub webhook signature.",
          ));
          return;
        }

        const eventName = singleHeader(request.headers["x-github-event"]);
        const deliveryId = singleHeader(request.headers["x-github-delivery"]);
        if (!eventName || !GITHUB_EVENT_NAME.test(eventName) || !deliveryId || !GITHUB_DELIVERY_ID.test(deliveryId)) {
          sendJson(response, 400, githubWebhookFailure(
            "GITHUB_WEBHOOK_INVALID_HEADERS",
            "GitHub event and delivery headers are required and must be bounded tokens.",
          ));
          return;
        }

        const payload = parseJson(body);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          sendJson(response, 400, githubWebhookFailure(
            "GITHUB_WEBHOOK_INVALID_JSON",
            "GitHub webhook JSON must be an object.",
          ));
          return;
        }

        let observation;
        try {
          const receivedAt = await canonicalGitHubReceivedAt(options, eventName, deliveryId);
          observation = mapGitHubWebhookObservation(eventName, deliveryId, payload, {
            signatureVerified: true,
            receivedAt,
          });
        } catch (error) {
          sendJson(response, 400, boundedGitHubMappingError(error));
          return;
        }

        if (!observation) {
          sendJson(response, 202, { accepted: true, ignored: true, event: eventName });
          return;
        }

        try {
          const result = await new ObservationLedger(options.store).append(observation);
          sendJson(response, 202, {
            accepted: true,
            duplicate: result.status === "duplicate",
            id: observation.id,
          });
        } catch (error) {
          if (error?.code === "OBSERVATION_ID_CONFLICT") {
            try {
              const existing = matchingGitHubObservation(await options.store.readAll(), eventName, deliveryId);
              if (sameGitHubDelivery(existing, observation)) {
                sendJson(response, 202, { accepted: true, duplicate: true, id: observation.id });
                return;
              }
            } catch {
              // Preserve the bounded conflict response below.
            }
            sendJson(response, 409, githubWebhookFailure(
              "OBSERVATION_ID_CONFLICT",
              "Observation identity was reused with different semantics.",
            ));
            return;
          }
          sendJson(response, 500, githubWebhookFailure(
            "GITHUB_WEBHOOK_INGESTION_FAILED",
            "GitHub webhook ingestion failed.",
          ));
        }
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
