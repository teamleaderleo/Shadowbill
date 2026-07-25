import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    const result = await emitObservation({
      store: new JsonlEventStore(join(directory, "events.jsonl")),
      text,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(result.status, "inserted");
    assert.equal(result.observation.data.ingestedAt, "2026-07-26T12:00:00.000Z");
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

test("rejects oversized files before reading their contents", async () => {
  await temporaryDirectory(async (directory) => {
    const path = join(directory, "large.json");
    await writeFile(path, Buffer.alloc(65_537, 0x20));
    await assert.rejects(readBoundedObservationFile(path), (error) => error.code === "OBSERVATION_TOO_LARGE");
  });
});

test("rejects invalid UTF-8", async () => {
  await temporaryDirectory(async (directory) => {
    const path = join(directory, "bad.json");
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    await assert.rejects(readBoundedObservationFile(path), (error) => error.code === "OBSERVATION_INVALID_UTF8");
  });
});

test("rejects symbolic-link observation files", { skip: process.platform === "win32" }, async () => {
  await temporaryDirectory(async (directory) => {
    const target = join(directory, "private-target.json");
    const link = join(directory, "observation.json");
    await writeFile(target, '{"private":"value-that-must-not-be-read"}');
    await symlink(target, link);
    await assert.rejects(
      readBoundedObservationFile(link),
      (error) => error.code === "OBSERVATION_SOURCE_SYMLINK" && !error.message.includes(target),
    );
  });
});

test("rejects non-regular files", async () => {
  await temporaryDirectory(async (directory) => {
    const path = join(directory, "input-directory");
    await mkdir(path);
    await assert.rejects(readBoundedObservationFile(path), (error) => error.code === "OBSERVATION_SOURCE_NOT_FILE");
  });
});

test("unavailable source errors do not disclose filesystem paths", async () => {
  await temporaryDirectory(async (directory) => {
    const missing = join(directory, "private", "missing-observation.json");
    await assert.rejects(
      readBoundedObservationFile(missing),
      (error) => error.code === "OBSERVATION_SOURCE_UNAVAILABLE" &&
        error.message === "Observation file could not be opened." &&
        !error.message.includes(directory),
    );
  });
});
