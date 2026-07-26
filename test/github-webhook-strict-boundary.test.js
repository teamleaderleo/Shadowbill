import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import { createCollectorServer, listen } from "../src/server.js";
import { JsonlEventStore } from "../src/store.js";

const SECRET = "strict-github-webhook-boundary-secret";
const FIXED_NOW = "2026-07-25T20:00:00.000Z";
const PRIVATE_LEDGER_ERROR = "PRIVATE_LEDGER_ERROR_SENTINEL";
const PRIVATE_DUPLICATE_KEY = "PRIVATE_DUPLICATE_KEY_SENTINEL";
const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

function signature(body) {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function validPushPayload() {
  return {
    repository: { full_name: "owner/repo" },
    before: "b".repeat(40),
    after: "a".repeat(40),
    size: 1,
    created: false,
    deleted: false,
    forced: false,
    head_commit: { timestamp: "2026-07-25T19:59:00.000Z" },
    commits: [],
  };
}

async function requestWebhook(port, body, deliveryId) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature(body),
      "x-github-event": "push",
      "x-github-delivery": deliveryId,
    },
    body,
  });
  const text = await response.text();
  return { status: response.status, text, value: JSON.parse(text) };
}

async function withServer(store, callback) {
  const server = createCollectorServer({
    store,
    registryStore: null,
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    githubWebhookSecret: SECRET,
    timeZone: "UTC",
    now: () => new Date(FIXED_NOW),
  });
  const port = await listen(server, 0);
  try {
    await callback(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("signed duplicate-key and malformed UTF-8 bodies fail before mapping or append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-github-strict-json-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  try {
    await withServer(store, async (port) => {
      const duplicateBody = Buffer.from(
        `{"repository":{"full_name":"owner/repo"},"repository":{"full_name":"${PRIVATE_DUPLICATE_KEY}"}}`,
        "utf8",
      );
      const duplicate = await requestWebhook(port, duplicateBody, "strict-duplicate-key");
      assert.equal(duplicate.status, 400);
      assert.deepEqual(duplicate.value, {
        accepted: false,
        error: {
          code: "GITHUB_WEBHOOK_INVALID_JSON",
          message: "GitHub webhook JSON must be one bounded strict object.",
        },
      });
      assert.equal(duplicate.text.includes(PRIVATE_DUPLICATE_KEY), false);

      const malformedUtf8 = Buffer.concat([
        Buffer.from('{"repository":{"full_name":"owner/repo"},"marker":"', "utf8"),
        Buffer.from([0xc0, 0x80]),
        Buffer.from('"}', "utf8"),
      ]);
      const malformed = await requestWebhook(port, malformedUtf8, "strict-invalid-utf8");
      assert.equal(malformed.status, 400);
      assert.equal(malformed.value.error.code, "GITHUB_WEBHOOK_INVALID_JSON");
      assert.equal((await store.readAll()).length, 0);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ledger failure is a bounded 500 and is never blamed on the signed payload", async () => {
  let eagerReads = 0;
  const unavailableStore = {
    async readAll() {
      eagerReads += 1;
      throw new Error(PRIVATE_LEDGER_ERROR);
    },
    async appendIdempotent() {
      throw new Error(PRIVATE_LEDGER_ERROR);
    },
  };
  const body = Buffer.from(JSON.stringify(validPushPayload()), "utf8");

  await withServer(unavailableStore, async (port) => {
    const result = await requestWebhook(port, body, "ledger-unavailable");
    assert.equal(result.status, 500);
    assert.deepEqual(result.value, {
      accepted: false,
      error: {
        code: "GITHUB_WEBHOOK_INGESTION_FAILED",
        message: "GitHub webhook ingestion failed.",
      },
    });
    assert.equal(result.text.includes(PRIVATE_LEDGER_ERROR), false);
    assert.equal(eagerReads, 0);
  });
});
