import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("fleet dashboard keeps one main landmark with scripting disabled", async () => {
  const html = await readFile(new URL("../dashboard/index.html", import.meta.url), "utf8");
  assert.equal((html.match(/<main(?:\s|>)/gu) ?? []).length, 1);
  assert.match(html, /<noscript>[\s\S]*aria-labelledby="noscript-heading"/u);
});
