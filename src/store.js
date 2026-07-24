import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonlEventStore {
  #ids;
  #writeQueue = Promise.resolve();

  constructor(path) {
    this.path = path;
  }

  async #loadIds() {
    if (this.#ids) return this.#ids;
    const events = await this.readAll();
    this.#ids = new Set(events.map((event) => event.id));
    return this.#ids;
  }

  /**
   * Appends an event once. Returns false when its ID already exists.
   * @param {import('./types.js').ShadowbillEvent} event
   * @returns {Promise<boolean>}
   */
  append(event) {
    const operation = this.#writeQueue.then(async () => {
      const ids = await this.#loadIds();
      if (ids.has(event.id)) return false;

      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
      ids.add(event.id);
      return true;
    });

    this.#writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** @returns {Promise<import('./types.js').ShadowbillEvent[]>} */
  async readAll() {
    try {
      const raw = await readFile(this.path, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line, index) => {
          try {
            return JSON.parse(line);
          } catch (error) {
            throw new Error(`Invalid JSONL at line ${index + 1}: ${String(error)}`);
          }
        });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }
}
