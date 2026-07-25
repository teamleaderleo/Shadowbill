#!/usr/bin/env node

if ((process.argv[2] ?? "help") === "emit") {
  const { formatEmitError, runEmitCommand } = await import("./emit-command.js");
  try {
    await runEmitCommand();
  } catch (error) {
    console.error(formatEmitError(error));
    process.exitCode = 1;
  }
} else {
  await import("./cli.js");
}
