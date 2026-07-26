import assert from "node:assert/strict";
import test from "node:test";
import { RENDERPROVE_RECEIPT_SCHEMA, validateRenderproveReceipt } from "../src/renderprove-adapter.js";

test("Renderprove receipt paths normalise Windows separators safely", () => {
  const value = validateRenderproveReceipt({
    $schema: RENDERPROVE_RECEIPT_SCHEMA,
    version: 1,
    project: "windows-project",
    source: { manifest: "config\\renderprove.json" },
    target: { baseUrl: "https://example.test" },
    startedAt: "2026-07-26T01:00:00.000Z",
    finishedAt: "2026-07-26T01:00:01.000Z",
    durationMs: 1000,
    status: "passed",
    summary: { cases: 1, passed: 1, failed: 0, diagnostics: 0 },
    runtime: { mode: "remote", logs: null },
    cases: [{
      id: "desktop:/",
      status: "passed",
      startedAt: "2026-07-26T01:00:00.000Z",
      finishedAt: "2026-07-26T01:00:01.000Z",
      route: {
        name: "home",
        path: "/",
        requestedUrl: "https://example.test/",
        finalUrl: "https://example.test/",
      },
      viewport: { name: "desktop", width: 1280, height: 720, deviceScaleFactor: 1 },
      navigation: { status: 200, ok: true },
      page: {
        title: "Home",
        lang: "en",
        bodyTextLength: 4,
        scrollWidth: 1280,
        clientWidth: 1280,
        scrollHeight: 720,
        clientHeight: 720,
      },
      artifacts: [{
        kind: "screenshot",
        path: ".renderprove\\screenshots\\home.png",
        mimeType: "image/png",
        sha256: "a".repeat(64),
      }],
      diagnostics: [],
    }],
  });

  assert.equal(value.manifest, "config/renderprove.json");
  assert.equal(value.cases[0].artifacts[0].path, ".renderprove/screenshots/home.png");
});

test("Renderprove receipt paths reject drive, UNC, and parent escape forms", () => {
  const base = {
    $schema: RENDERPROVE_RECEIPT_SCHEMA,
    version: 1,
    project: "windows-project",
    source: { manifest: null },
    target: { baseUrl: "https://example.test" },
    startedAt: "2026-07-26T01:00:00.000Z",
    finishedAt: "2026-07-26T01:00:01.000Z",
    durationMs: 1000,
    status: "passed",
    summary: { cases: 1, passed: 1, failed: 0, diagnostics: 0 },
    runtime: { mode: "remote", logs: null },
    cases: [{
      id: "desktop:/",
      status: "passed",
      startedAt: "2026-07-26T01:00:00.000Z",
      finishedAt: "2026-07-26T01:00:01.000Z",
      route: { name: "home", path: "/", requestedUrl: "https://example.test/", finalUrl: "https://example.test/" },
      viewport: { name: "desktop", width: 1280, height: 720, deviceScaleFactor: 1 },
      navigation: { status: 200, ok: true },
      page: null,
      artifacts: [{ kind: "screenshot", path: "safe.png", mimeType: "image/png", sha256: "a".repeat(64) }],
      diagnostics: [],
    }],
  };

  for (const unsafe of ["C:\\private.png", "\\\\server\\share\\private.png", "..\\private.png"]) {
    const candidate = structuredClone(base);
    candidate.cases[0].artifacts[0].path = unsafe;
    assert.throws(
      () => validateRenderproveReceipt(candidate),
      (error) => error.code === "RENDERPROVE_PATH_ESCAPE",
    );
  }
});
