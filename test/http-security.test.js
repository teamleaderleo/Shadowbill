import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import {
  browserCorsHeaders,
  isAllowedHost,
  normalizeAllowedHosts,
  parseHostAuthority,
} from "../src/http-security.js";
import { createCollectorServer, listen } from "../src/server.js";
import { JsonlEventStore } from "../src/store.js";

const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

function rawRequest(url, options = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers ?? {}) };
    if (options.hostHeader !== undefined) headers.host = options.hostHeader;
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "GET",
      headers,
      setHost: options.setHost ?? true,
    }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: body ? JSON.parse(body) : null,
      }));
    });
    request.once("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

async function withServer(callback, extraOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-http-security-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  const server = createCollectorServer({
    store,
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    timeZone: "America/Los_Angeles",
    collectorToken: "collector-token-with-at-least-thirty-two-characters",
    ...extraOptions,
  });
  const port = await listen(server, 0);
  try {
    await callback(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("Host authorities and allowlists reject ambiguous values", () => {
  assert.deepEqual(parseHostAuthority("localhost:7337"), { host: "localhost", port: 7337 });
  assert.deepEqual(parseHostAuthority("[::1]:7337"), { host: "[::1]", port: 7337 });
  assert.equal(parseHostAuthority("localhost:0"), null);
  assert.equal(parseHostAuthority("localhost:65536"), null);
  assert.equal(parseHostAuthority("user@localhost"), null);
  assert.equal(parseHostAuthority("localhost/path"), null);

  const allowed = normalizeAllowedHosts(["localhost", "shadowbill.internal:8443"]);
  assert.equal(isAllowedHost(undefined, allowed), false);
  assert.equal(isAllowedHost("localhost:7337", allowed), true);
  assert.equal(isAllowedHost("shadowbill.internal:8443", allowed), true);
  assert.equal(isAllowedHost("shadowbill.internal:443", allowed), false);
  assert.throws(() => normalizeAllowedHosts(["bad host"]), /Invalid allowed host/);
});

test("CORS is limited to authenticated browser routes", () => {
  assert.equal(browserCorsHeaders("/v1/events")["access-control-allow-origin"], "*");
  assert.equal(browserCorsHeaders("/v1/auth/check")["access-control-allow-origin"], "*");
  assert.equal(browserCorsHeaders("/v1/auth/check")["access-control-allow-methods"], "GET,OPTIONS");
  assert.equal(browserCorsHeaders("/v1/events")["access-control-allow-methods"], "POST,OPTIONS");
  assert.deepEqual(browserCorsHeaders("/v1/report"), {});
  assert.deepEqual(browserCorsHeaders("/health"), {});
  assert.deepEqual(browserCorsHeaders("/v1/github/webhooks"), {});
});

test("collector applies route-scoped CORS and rejects DNS-rebinding hosts", async () => {
  await withServer(async (url, port) => {
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), null);

    const report = await fetch(`${url}/v1/report?date=2026-07-25`);
    assert.equal(report.status, 200);
    assert.equal(report.headers.get("access-control-allow-origin"), null);

    const unauthorized = await fetch(`${url}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), "*");

    const eventPreflight = await fetch(`${url}/v1/events`, { method: "OPTIONS" });
    assert.equal(eventPreflight.status, 204);
    assert.equal(eventPreflight.headers.get("access-control-allow-origin"), "*");
    assert.equal(eventPreflight.headers.get("access-control-allow-headers"), "authorization,content-type");
    assert.equal(eventPreflight.headers.get("access-control-allow-methods"), "POST,OPTIONS");

    const reportPreflight = await fetch(`${url}/v1/report`, { method: "OPTIONS" });
    assert.equal(reportPreflight.status, 404);
    assert.equal(reportPreflight.headers.get("access-control-allow-origin"), null);

    const attacker = await rawRequest(`${url}/v1/events`, {
      method: "OPTIONS",
      hostHeader: "attacker.example",
    });
    assert.equal(attacker.status, 421);
    assert.equal(attacker.headers["access-control-allow-origin"], undefined);

    const missing = await rawRequest(`${url}/health`, { setHost: false });
    assert.ok([400, 421].includes(missing.status));
    assert.equal(missing.headers["access-control-allow-origin"], undefined);

    const invalidPort = await rawRequest(`${url}/health`, { hostHeader: "localhost:99999" });
    assert.equal(invalidPort.status, 421);

    const localhost = await rawRequest(`${url}/health`, { hostHeader: `localhost:${port}` });
    assert.equal(localhost.status, 200);

    const ipv6Loopback = await rawRequest(`${url}/health`, { hostHeader: `[::1]:${port}` });
    assert.equal(ipv6Loopback.status, 200);
  });
});

test("collector accepts only explicitly configured reverse-proxy hosts", async () => {
  await withServer(async (url) => {
    const approved = await rawRequest(`${url}/health`, { hostHeader: "shadowbill.internal:8443" });
    assert.equal(approved.status, 200);

    const wrongPort = await rawRequest(`${url}/health`, { hostHeader: "shadowbill.internal:443" });
    assert.equal(wrongPort.status, 421);

    const defaultLoopback = await rawRequest(`${url}/health`, { hostHeader: "127.0.0.1:7337" });
    assert.equal(defaultLoopback.status, 421);
  }, { allowedHosts: ["shadowbill.internal:8443"] });
});
