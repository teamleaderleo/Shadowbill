import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function secureEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function verifyBearerAuthorization(header, token) {
  if (typeof header !== "string" || typeof token !== "string" || token.length === 0) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return secureEqual(header.slice(prefix.length), token);
}

export async function loadOrCreateCollectorToken(path) {
  await mkdir(dirname(path), { recursive: true });

  try {
    const token = (await readFile(path, "utf8")).trim();
    if (token.length < 32) throw new Error(`Collector token at ${path} is too short`);
    await chmod(path, 0o600);
    return token;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }

  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length < 32) throw new Error(`Collector token at ${path} is too short`);
    await chmod(path, 0o600);
    return existing;
  }
}
