import {
  ENVIRONMENT_ALIASES,
  PRODUCT_NAME,
  resolveStorageIdentity,
  selectCompatibleEnvironment,
} from "./identity.js";
import {
  buildProofwakeDoctorReport,
  formatProofwakeDoctorReport,
  proofwakeDoctorExitCode,
} from "./proofwake-doctor.js";

class DoctorUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "DoctorUsageError";
    this.code = "PROOFWAKE_DOCTOR_USAGE";
  }
}

function value(args, index, name) {
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) throw new DoctorUsageError(`${name} requires a value.`);
  return next;
}

function parseArguments(args) {
  const options = {
    dataPath: undefined,
    tokenPath: undefined,
    pricingPath: undefined,
    model: "gpt-5.6-sol",
    timeZone: undefined,
    registryPath: undefined,
    json: false,
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (entry === "--help" || entry === "-h") {
      options.help = true;
      continue;
    }
    if (entry === "--json") {
      if (options.json) throw new DoctorUsageError("--json may be supplied once.");
      options.json = true;
      continue;
    }
    if (["--data", "--collector-token-file", "--pricing", "--model", "--timezone", "--registry"].includes(entry)) {
      if (seen.has(entry)) throw new DoctorUsageError(`${entry} may be supplied once.`);
      seen.add(entry);
      const next = value(args, index, entry);
      index += 1;
      if (entry === "--data") options.dataPath = next;
      else if (entry === "--collector-token-file") options.tokenPath = next;
      else if (entry === "--pricing") options.pricingPath = next;
      else if (entry === "--model") options.model = next;
      else if (entry === "--timezone") options.timeZone = next;
      else options.registryPath = next;
      continue;
    }
    throw new DoctorUsageError(`Unknown doctor argument: ${entry}`);
  }
  return options;
}

function environment(key) {
  const [primary, legacy] = ENVIRONMENT_ALIASES[key];
  return selectCompatibleEnvironment(process.env, primary, legacy);
}

function warnings(values) {
  return [...new Set(values)];
}

function help() {
  return `Proofwake doctor

  doctor [--registry PATH] [--data PATH] [--collector-token-file PATH]
         [--pricing PATH] [--model MODEL] [--timezone IANA_NAME] [--json]

Checks the active ledger, optional Shadowbill estimate module, repository registry,
enrolled checkouts, committed policies, and declared adapter receipt paths. The command
is read-only and does not create token files, registries, locks, or receipt files.`;
}

function errorDetails(error) {
  const code = typeof error?.code === "string" ? error.code : "PROOFWAKE_DOCTOR_FAILED";
  const message = error instanceof DoctorUsageError
    ? error.message
    : "Proofwake doctor could not complete.";
  return { code, message };
}

export async function runDoctorCommand(args) {
  const requestedJson = args.includes("--json");
  try {
    const options = parseArguments(args);
    if (options.help) {
      console.log(help());
      return;
    }
    const storage = await resolveStorageIdentity({
      explicitDataPath: options.dataPath,
      explicitTokenPath: options.tokenPath,
    });
    const collectorToken = environment("collectorToken");
    const timeZoneEnvironment = environment("timezone");
    const compatibilityWarnings = warnings([
      ...storage.warnings,
      ...collectorToken.warnings,
      ...timeZoneEnvironment.warnings,
    ]);
    const report = await buildProofwakeDoctorReport({
      dataPath: storage.dataPath,
      tokenPath: storage.tokenPath,
      tokenFromEnvironment: collectorToken.value !== undefined,
      pricingPath: options.pricingPath,
      model: options.model,
      timeZone: options.timeZone ?? timeZoneEnvironment.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      registryPath: options.registryPath,
    });
    const response = {
      ...report,
      compatibility: {
        active: storage.compatibilityMode,
        dataSource: storage.dataSource,
        tokenPathSource: storage.tokenSource,
        warnings: compatibilityWarnings,
      },
    };
    if (options.json) {
      console.log(JSON.stringify(response, null, 2));
    } else {
      for (const warning of compatibilityWarnings) console.error(`${PRODUCT_NAME} compatibility: ${warning}`);
      console.log(formatProofwakeDoctorReport(response));
    }
    process.exitCode = proofwakeDoctorExitCode(response);
  } catch (error) {
    const response = {
      service: "proofwake",
      command: "doctor",
      status: "error",
      error: errorDetails(error),
    };
    if (requestedJson) console.log(JSON.stringify(response, null, 2));
    else console.error(`Proofwake doctor: ${response.error.code}: ${response.error.message}`);
    process.exitCode = 1;
  }
}
