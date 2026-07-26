import { readFile } from "node:fs/promises";

const ASSETS = new Map([
  ["/dashboard/", { file: new URL("../dashboard/index.html", import.meta.url), contentType: "text/html; charset=utf-8", noStore: true }],
  ["/dashboard/estimates/", { file: new URL("../dashboard/estimates.html", import.meta.url), contentType: "text/html; charset=utf-8", noStore: true }],
  ["/dashboard/estimates/index.html", { file: new URL("../dashboard/estimates.html", import.meta.url), contentType: "text/html; charset=utf-8", noStore: true }],
  ["/dashboard/fleet.css", { file: new URL("../dashboard/fleet.css", import.meta.url), contentType: "text/css; charset=utf-8" }],
  ["/dashboard/fleet.js", { file: new URL("../dashboard/fleet.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/dashboard/dashboard.css", { file: new URL("../dashboard/dashboard.css", import.meta.url), contentType: "text/css; charset=utf-8" }],
  ["/dashboard/dashboard.js", { file: new URL("../dashboard/dashboard.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
]);

const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

const cache = new Map();

export function isDashboardPath(pathname) {
  return pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

export async function dashboardResponse(pathname) {
  if (pathname === "/" || pathname === "/dashboard") {
    return {
      status: 308,
      headers: { location: "/dashboard/", ...SECURITY_HEADERS, "cache-control": "no-store" },
      body: Buffer.alloc(0),
    };
  }
  if (pathname === "/dashboard/estimates") {
    return {
      status: 308,
      headers: { location: "/dashboard/estimates/", ...SECURITY_HEADERS, "cache-control": "no-store" },
      body: Buffer.alloc(0),
    };
  }

  const asset = ASSETS.get(pathname);
  if (!asset) {
    const body = Buffer.from(JSON.stringify({ error: "Dashboard asset not found" }));
    return {
      status: 404,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(body.length),
        "cache-control": "no-store",
        ...SECURITY_HEADERS,
      },
      body,
    };
  }
  let body = cache.get(pathname);
  if (!body) {
    body = await readFile(asset.file);
    cache.set(pathname, body);
  }
  return {
    status: 200,
    headers: {
      "content-type": asset.contentType,
      "content-length": String(body.length),
      "cache-control": asset.noStore ? "no-store" : "public, max-age=300",
      ...SECURITY_HEADERS,
    },
    body,
  };
}
