#!/usr/bin/env node

if ((process.argv[2] ?? "help") === "emit") {
  const { formatEmitFailure, runEmitCommand } = await import("./emit-command.js");
  try {
    await runEmitCommand();
  } catch (error) {
    console.error(formatEmitFailure(error));
    process.exitCode = 1;
  }
} else {
  await import("./cli.js");
}
