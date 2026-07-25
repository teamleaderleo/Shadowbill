import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function manifest() {
  return JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
}

test("browser manifest loads shared config before collection scripts", async () => {
  const value = await manifest();
  assert.deepEqual(value.content_scripts[0].js, ["config.js", "turn-tracker.js", "content.js"]);
});

test("browser manifest keeps the default collector required and custom origins optional", async () => {
  const value = await manifest();
  assert.ok(value.host_permissions.includes("http://127.0.0.1/*"));
  assert.ok(value.optional_host_permissions.includes("http://*/*"));
  assert.ok(value.optional_host_permissions.includes("https://*/*"));
});
