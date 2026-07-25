import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(root, arguments_) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Resolves a default branch only from an explicit local remote HEAD symbolic ref.
 * No network request or branch-name convention is used.
 * @param {string} root
 * @param {{name: string, repository: string | null}[]} remotes
 */
export async function inspectDefaultBranch(root, remotes) {
  for (const remote of remotes) {
    if (!remote.repository) continue;
    const value = await git(root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${remote.name}/HEAD`,
    ]);
    const prefix = `${remote.name}/`;
    if (value.startsWith(prefix) && value.length > prefix.length) {
      return {
        branch: value.slice(prefix.length),
        source: `refs/remotes/${remote.name}/HEAD`,
        remote: remote.name,
      };
    }
  }
  return null;
}
