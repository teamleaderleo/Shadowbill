import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PRODUCT_NAME = "Proofwake";
export const PRODUCT_SLUG = "proofwake";
export const LEGACY_NAME = "Shadowbill";
export const LEGACY_SLUG = "shadowbill";

export const ENVIRONMENT_ALIASES = Object.freeze({
  data: ["PROOFWAKE_DATA", "SHADOWBILL_DATA"],
  collectorTokenFile: ["PROOFWAKE_COLLECTOR_TOKEN_FILE", "SHADOWBILL_COLLECTOR_TOKEN_FILE"],
  collectorToken: ["PROOFWAKE_COLLECTOR_TOKEN", "SHADOWBILL_COLLECTOR_TOKEN"],
  timezone: ["PROOFWAKE_TIMEZONE", "SHADOWBILL_TIMEZONE"],
  githubWebhookSecret: ["PROOFWAKE_GITHUB_WEBHOOK_SECRET", "SHADOWBILL_GITHUB_WEBHOOK_SECRET"],
  allowedHosts: ["PROOFWAKE_ALLOWED_HOSTS", "SHADOWBILL_ALLOWED_HOSTS"],
  mcpAllowWrites: ["PROOFWAKE_MCP_ALLOW_WRITES", "SHADOWBILL_MCP_ALLOW_WRITES"],
});

async function defaultPathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Selects a Proofwake environment value while preserving one legacy Shadowbill alias.
 * The primary name always wins when both are present.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment
 * @param {string} primaryName
 * @param {string} legacyName
 */
export function selectCompatibleEnvironment(environment, primaryName, legacyName) {
  const primaryValue = environment[primaryName];
  const legacyValue = environment[legacyName];
  const warnings = [];

  if (primaryValue !== undefined) {
    if (legacyValue !== undefined) {
      warnings.push(`${legacyName} is ignored because ${primaryName} is set.`);
    }
    return { value: primaryValue, source: primaryName, legacy: false, warnings };
  }

  if (legacyValue !== undefined) {
    warnings.push(`${legacyName} is a compatibility alias; prefer ${primaryName}.`);
    return { value: legacyValue, source: legacyName, legacy: true, warnings };
  }

  return { value: undefined, source: null, legacy: false, warnings };
}

/**
 * Resolves the active ledger and collector-token paths without mutating the filesystem.
 * A clean installation uses ~/.proofwake. An existing ~/.shadowbill ledger remains active
 * until an explicit migration is performed. Two implicit ledgers are rejected as ambiguous.
 * @param {{
 *   explicitDataPath?: string,
 *   explicitTokenPath?: string,
 *   environment?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   home?: string,
 *   pathExists?: (path: string) => Promise<boolean>,
 * }} [options]
 */
export async function resolveStorageIdentity(options = {}) {
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const pathExists = options.pathExists ?? defaultPathExists;
  const proofwakeDirectory = join(home, ".proofwake");
  const legacyDirectory = join(home, ".shadowbill");
  const proofwakeDataPath = join(proofwakeDirectory, "events.jsonl");
  const legacyDataPath = join(legacyDirectory, "events.jsonl");
  const proofwakeTokenPath = join(proofwakeDirectory, "collector-token");
  const legacyTokenPath = join(legacyDirectory, "collector-token");
  const warnings = [];

  const dataEnvironment = selectCompatibleEnvironment(
    environment,
    ENVIRONMENT_ALIASES.data[0],
    ENVIRONMENT_ALIASES.data[1],
  );
  warnings.push(...dataEnvironment.warnings);

  let dataPath;
  let dataSource;
  let compatibilityMode = false;

  if (options.explicitDataPath !== undefined) {
    dataPath = resolve(options.explicitDataPath);
    dataSource = "argument";
  } else if (dataEnvironment.value !== undefined) {
    dataPath = resolve(dataEnvironment.value);
    dataSource = dataEnvironment.source;
    compatibilityMode = dataEnvironment.legacy;
  } else {
    const [proofwakeExists, legacyExists] = await Promise.all([
      pathExists(proofwakeDataPath),
      pathExists(legacyDataPath),
    ]);

    if (proofwakeExists && legacyExists) {
      throw new Error(
        `Both ${proofwakeDataPath} and ${legacyDataPath} exist. Select one explicitly with --data or PROOFWAKE_DATA; Proofwake will not merge ledgers automatically.`,
      );
    }

    if (legacyExists) {
      dataPath = legacyDataPath;
      dataSource = "shadowbill-default";
      compatibilityMode = true;
      warnings.push(`Using the existing Shadowbill ledger at ${legacyDataPath}; migrate it explicitly before adopting ${proofwakeDataPath}.`);
    } else {
      dataPath = proofwakeDataPath;
      dataSource = "proofwake-default";
    }
  }

  const tokenEnvironment = selectCompatibleEnvironment(
    environment,
    ENVIRONMENT_ALIASES.collectorTokenFile[0],
    ENVIRONMENT_ALIASES.collectorTokenFile[1],
  );
  warnings.push(...tokenEnvironment.warnings);

  let tokenPath;
  let tokenSource;
  if (options.explicitTokenPath !== undefined) {
    tokenPath = resolve(options.explicitTokenPath);
    tokenSource = "argument";
  } else if (tokenEnvironment.value !== undefined) {
    tokenPath = resolve(tokenEnvironment.value);
    tokenSource = tokenEnvironment.source;
  } else if (dataPath === legacyDataPath) {
    tokenPath = legacyTokenPath;
    tokenSource = "shadowbill-default";
  } else {
    tokenPath = proofwakeTokenPath;
    tokenSource = "proofwake-default";
  }

  return {
    product: PRODUCT_SLUG,
    legacyAlias: LEGACY_SLUG,
    dataPath,
    dataSource,
    tokenPath,
    tokenSource,
    compatibilityMode,
    defaults: {
      proofwakeDataPath,
      legacyDataPath,
      proofwakeTokenPath,
      legacyTokenPath,
    },
    warnings,
  };
}
