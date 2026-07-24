import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { estimateTokens } from "./tokenize.js";

const execFileAsync = promisify(execFile);

async function git(repo, args) {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    maxBuffer: 20 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout.trimEnd();
}

function parseNumstat(raw) {
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [added, removed] = line.split("\t");
    if (added === undefined || removed === undefined) continue;
    changedFiles += 1;
    if (added !== "-") additions += Number.parseInt(added, 10) || 0;
    if (removed !== "-") deletions += Number.parseInt(removed, 10) || 0;
  }

  return { additions, deletions, changedFiles };
}

function addedLinesFromPatch(patch) {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

/** @returns {Promise<import('./types.js').GitCommitEvent>} */
export async function collectHeadCommit(repoPath) {
  const repo = resolve(repoPath);
  const [sha, branch, subject, timestamp, remote, numstat, patch] = await Promise.all([
    git(repo, ["rev-parse", "HEAD"]),
    git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(repo, ["show", "-s", "--format=%s", "HEAD"]),
    git(repo, ["show", "-s", "--format=%cI", "HEAD"]),
    git(repo, ["remote", "get-url", "origin"]).catch(() => ""),
    git(repo, ["show", "--numstat", "--format=", "--no-renames", "HEAD"]),
    git(repo, ["show", "--format=", "--no-renames", "--unified=0", "--no-color", "HEAD"]),
  ]);

  const stats = parseNumstat(numstat);
  const repository = remote
    ? remote.replace(/\.git$/, "").replace(/^git@github\.com:/, "").replace(/^https:\/\/github\.com\//, "")
    : basename(repo);
  const eventKey = createHash("sha256").update(`${repository}:${sha}`).digest("hex").slice(0, 24);

  return {
    type: "git_commit",
    id: `git_${eventKey}`,
    timestamp,
    repository,
    branch,
    sha,
    subject,
    ...stats,
    addedCodeTokens: estimateTokens(addedLinesFromPatch(patch)),
    collectorVersion: "0.3.0",
  };
}

export async function installPostCommitHook(repoPath, cliPath) {
  const repo = resolve(repoPath);
  const gitDir = await git(repo, ["rev-parse", "--git-dir"]);
  const hooksDir = resolve(repo, gitDir, "hooks");
  const hookPath = join(hooksDir, "post-commit");
  const marker = "# shadowbill:post-commit";
  const command = `${marker}\nnode ${JSON.stringify(resolve(cliPath))} ingest-git --repo ${JSON.stringify(repo)} >/dev/null 2>&1 &\n`;

  await mkdir(hooksDir, { recursive: true });
  let existing = "";
  try {
    existing = await readFile(hookPath, "utf8");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }

  if (existing.includes(marker)) return hookPath;
  if (existing) {
    const firstLine = existing.split("\n", 1)[0] ?? "";
    if (firstLine.startsWith("#!") && !/(?:ba|z|da|k)?sh\b/.test(firstLine)) {
      throw new Error(`Existing post-commit hook uses an unsupported interpreter: ${firstLine}`);
    }
  }

  const script = existing
    ? `${existing.trimEnd()}\n\n${command}`
    : `#!/bin/sh\n${command}`;
  await writeFile(hookPath, script, "utf8");
  await chmod(hookPath, 0o755);
  return hookPath;
}
