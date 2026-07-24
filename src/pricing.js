import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @returns {Promise<{version:string, source:string, models:Record<string, import('./types.js').ModelPricing>}>} */
export async function loadPricingCatalog(path) {
  const pricingPath = path ?? resolve(here, "../config/pricing.json");
  const raw = await readFile(pricingPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed.version || !parsed.models || Object.keys(parsed.models).length === 0) {
    throw new Error(`Invalid pricing catalog: ${pricingPath}`);
  }

  return parsed;
}
