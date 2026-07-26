import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { createCollectorServer, listen } from "../src/server.js";

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, text, body: JSON.parse(text) });
      });
    });
    req.once("error", reject);
    req.end();
  });
}

test("history HTTP failures preserve codes and suppress internal prose", async () => {
  const secret = "private-registry-field-sentinel";
  const error = new Error(`Unknown registry field: ${secret}.`);
  error.code = "REPOSITORY_REGISTRY_UNKNOWN_FIELD";
  const server = createCollectorServer({
    store: { readAll: async () => [] },
    registryStore: { read: async () => { throw error; } },
    collectorToken: "history-disclosure-token-with-more-than-thirty-two-characters",
    timeZone: "UTC",
    pricing: {},
    profile: {},
  });
  const port = await listen(server, 0);
  try {
    const response = await get(port, "/v1/failures");
    assert.equal(response.status, 500);
    assert.equal(response.body.status, "error");
    assert.equal(response.body.error.code, "REPOSITORY_REGISTRY_UNKNOWN_FIELD");
    assert.equal(response.body.error.message, "History report generation failed.");
    assert.equal(response.text.includes(secret), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
