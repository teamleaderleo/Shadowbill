import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadConfig() {
  const source = await readFile(new URL("../extension/config.js", import.meta.url), "utf8");
  const context = vm.createContext({ URL });
  vm.runInContext(source, context, { filename: "config.js" });
  return context.ShadowbillConfig;
}

test("collector URLs normalize to an origin and exact permission pattern", async () => {
  const config = await loadConfig();
  assert.equal(config.normalizeCollectorUrl(" http://localhost:7444/path?ignored=1#hash "), "http://localhost:7444");
  assert.equal(config.collectorPermissionPattern("https://shadowbill.example/base"), "https://shadowbill.example/*");
});

test("collector URLs reject unsupported schemes and embedded credentials", async () => {
  const config = await loadConfig();
  assert.throws(() => config.normalizeCollectorUrl("file:///tmp/shadowbill"), /http or https/);
  assert.throws(() => config.normalizeCollectorUrl("http://user:secret@localhost:7337"), /username or password/);
  assert.throws(() => config.normalizeCollectorUrl(""), /required/);
});

test("collector tokens enforce the server setup minimum", async () => {
  const config = await loadConfig();
  assert.equal(config.normalizeCollectorToken("a".repeat(32)), "a".repeat(32));
  assert.throws(() => config.normalizeCollectorToken("too-short"), /at least 32/);
});

test("model slugs match the collector validation boundary", async () => {
  const config = await loadConfig();
  assert.equal(config.normalizeModel(" gpt-5.6-sol:preview "), "gpt-5.6-sol:preview");
  assert.throws(() => config.normalizeModel("model name with spaces"), /letters, numbers/);
  assert.throws(() => config.normalizeModel("-leading-hyphen"), /letters, numbers/);
});
