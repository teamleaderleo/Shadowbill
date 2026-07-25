import assert from "node:assert/strict";
import test from "node:test";
import { parseStrictJson } from "../src/strict-json.js";

test("strict JSON rejects duplicate keys at nested paths", () => {
  assert.throws(
    () => parseStrictJson('{"policy":{"state":"active","state":"dormant"}}', { prefix: "TEST" }),
    (error) => error.code === "TEST_DUPLICATE_KEY" && error.path === "$.policy.state",
  );
});

test("strict JSON rejects non-finite numbers and excessive depth", () => {
  assert.throws(
    () => parseStrictJson('{"value":1e999}', { prefix: "TEST" }),
    (error) => error.code === "TEST_NON_FINITE_NUMBER",
  );
  const nested = `${"[".repeat(6)}0${"]".repeat(6)}`;
  assert.throws(
    () => parseStrictJson(nested, { prefix: "TEST", maxDepth: 4 }),
    (error) => error.code === "TEST_TOO_DEEP",
  );
});

test("strict JSON returns valid values after a complete scan", () => {
  assert.deepEqual(parseStrictJson('{"value":[1,true,null,"ok"]}', { prefix: "TEST" }), {
    value: [1, true, null, "ok"],
  });
});
