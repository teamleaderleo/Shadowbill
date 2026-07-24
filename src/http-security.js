import { isIP } from "node:net";

export const DEFAULT_ALLOWED_HOSTS = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);

const BROWSER_ROUTES = new Set(["/v1/auth/check", "/v1/events"]);

function validDnsName(value) {
  if (value.length < 1 || value.length > 253 || !/^[a-z0-9.-]+$/i.test(value)) return false;
  return value.split(".").every((label) => label.length >= 1 && label.length <= 63 &&
    !label.startsWith("-") && !label.endsWith("-"));
}

export function parseHostAuthority(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\\/@,\s]/.test(value)) return null;

  let host;
  let portText;
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (!match || isIP(match[1]) !== 6) return null;
    host = `[${match[1].toLowerCase()}]`;
    portText = match[2];
  } else {
    const match = /^([^:]+)(?::(\d+))?$/.exec(value);
    if (!match) return null;
    host = match[1].toLowerCase();
    portText = match[2];
    const ipVersion = isIP(host);
    if (ipVersion !== 4 && !validDnsName(host)) return null;
  }

  let port = null;
  if (portText !== undefined) {
    port = Number(portText);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  }
  return { host, port };
}

export function normalizeAllowedHosts(values = DEFAULT_ALLOWED_HOSTS) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("allowedHosts must contain at least one host");
  return values.map((value) => {
    const authority = parseHostAuthority(value);
    if (!authority) throw new Error(`Invalid allowed host: ${String(value)}`);
    return authority;
  });
}

export function isAllowedHost(value, allowedHosts) {
  const authority = parseHostAuthority(value);
  if (!authority) return false;
  return allowedHosts.some((allowed) => allowed.host === authority.host &&
    (allowed.port === null || allowed.port === authority.port));
}

export function browserCorsHeaders(pathname) {
  if (!BROWSER_ROUTES.has(pathname)) return {};
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
}
