import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emitObservation, readBoundedObservationFile, readBoundedObservationStream } from "../src/emit.js";
import { JsonlEventStore } from "../src/store.js";

async function temporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-emit-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("reads and emits a bounded observation file", async () => {
  await temporaryDirectory(async (directory) => {
    const fixture = new URL("./fixtures/observations/renderprove-browser-review-passed-v1.json", import.meta.url);
    const text = await readBoundedObservationFile(fixture);
    const result = await emitObservation({ store: new JsonlEventStore(join(directory, "events.jsonl")), text });
    assert.equal(result.status, "inserted");
  });
});

test("reads bounded stdin-like streams", async () => {
  const text = await readFile(new URL("./fixtures/observations/smolrunner-host-warning-v1.json", import.meta.url), "utf8");
  async function* chunks() {
    yield Buffer.from(text.slice(0, 20));
    yield Buffer.from(text.slice(20));
  }
  assert.equal(await readBoundedObservationStream(chunks()), text);
});

test("rejects oversized streams before parsing", async () => {
  async function* chunks() {
    yield Buffer.alloc(65536);
    yield Buffer.from("x");
  }
  await assert.rejects(readBoundedObservationStream(chunks()), (error) => error.code === "OBSERVATION_TOO_LARGE");
});

test("rejects invalid UTF-8", async () => {
  await temporaryDirectory(async (directory) => {
    const path = join(directory, "bad.json");
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    await assert.rejects(readBoundedObservationFile(path), (error) => error.code === "OBSERVATION_INVALID_UTF8");
  });
});
