import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
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

async function withServer(callback) {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-dashboard-"));
  const server = createCollectorServer({
    store: new JsonlEventStore(join(directory, "events.jsonl")),
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    timeZone: "America/Los_Angeles",
    collectorToken: "collector-token-with-at-least-thirty-two-characters",
  });
  const port = await listen(server, 0);
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("dashboard redirects to a canonical same-origin route", async () => {
  await withServer(async (url) => {
    for (const path of ["/", "/dashboard"]) {
      const response = await fetch(`${url}${path}`, { redirect: "manual" });
      assert.equal(response.status, 308);
      assert.equal(response.headers.get("location"), "/dashboard/");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("x-frame-options"), "DENY");
    }
    const estimates = await fetch(`${url}/dashboard/estimates`, { redirect: "manual" });
    assert.equal(estimates.status, 308);
    assert.equal(estimates.headers.get("location"), "/dashboard/estimates/");
  });
});

test("estimate dashboard assets are local, typed, and locked to the collector origin", async () => {
  await withServer(async (url) => {
    const htmlResponse = await fetch(`${url}/dashboard/estimates/`);
    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get("content-type"), /^text\/html/);
    assert.equal(htmlResponse.headers.get("access-control-allow-origin"), null);
    assert.equal(htmlResponse.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(htmlResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(htmlResponse.headers.get("referrer-policy"), "no-referrer");
    const csp = htmlResponse.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);

    const html = await htmlResponse.text();
    assert.match(html, /\/dashboard\/dashboard\.css/);
    assert.match(html, /\/dashboard\/dashboard\.js/);
    assert.match(html, /href="\/dashboard\/"/);
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(html, /<script[^>]+src=["']\/\//i);

    const cssResponse = await fetch(`${url}/dashboard/dashboard.css`);
    assert.equal(cssResponse.status, 200);
    assert.match(cssResponse.headers.get("content-type"), /^text\/css/);
    assert.equal(cssResponse.headers.get("access-control-allow-origin"), null);
    const css = await cssResponse.text();
    assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/i);

    const scriptResponse = await fetch(`${url}/dashboard/dashboard.js`);
    assert.equal(scriptResponse.status, 200);
    assert.match(scriptResponse.headers.get("content-type"), /^text\/javascript/);
    assert.equal(scriptResponse.headers.get("access-control-allow-origin"), null);
    const script = await scriptResponse.text();
    assert.match(script, /\/v1\/report/);
    assert.doesNotMatch(script, /fetch\(\s*["']https?:/i);
    assert.doesNotMatch(script, /WebSocket\s*\(\s*["']https?:/i);
  });
});

test("dashboard supports HEAD and rejects unknown assets without CORS", async () => {
  await withServer(async (url) => {
    const head = await fetch(`${url}/dashboard/dashboard.css`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type"), /^text\/css/);
    assert.equal(await head.text(), "");

    const missing = await fetch(`${url}/dashboard/missing.js`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("access-control-allow-origin"), null);
    assert.equal(missing.headers.get("x-frame-options"), "DENY");
  });
});
