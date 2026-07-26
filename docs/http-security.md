# HTTP boundary security

Shadowbill binds its collector to `127.0.0.1`. It also validates the HTTP `Host` authority before routing a request.

The default allowlist is:

- `127.0.0.1`
- `localhost`
- `[::1]`

A host entry without a port accepts that host on the collector's active port. An entry with a port requires an exact host-and-port match.

## Reverse proxies

A reverse proxy that preserves an external `Host` header must add that authority explicitly:

```bash
SHADOWBILL_ALLOWED_HOSTS='shadowbill.example' npm run serve
```

Multiple entries use commas:

```bash
node src/cli.js serve --allowed-hosts 'shadowbill.example,shadowbill.internal:8443'
```

Malformed entries stop the collector during startup. Keep this list narrow. A proxy can instead rewrite `Host` to `127.0.0.1`, which works with the default configuration.

The listener remains loopback-only. A hosted GitHub webhook setup should terminate TLS at the proxy and forward only `/v1/github/webhooks`. The signature authority, observation write, replay, conflict, and disclosure contracts are documented in [`github-webhook-ingestion.md`](github-webhook-ingestion.md).

## Browser cross-origin access

CORS response headers are emitted only for the extension-facing routes:

- `GET /v1/auth/check`
- `POST /v1/events`
- preflight requests for those two routes

Both routes still require the collector bearer token for useful access. Reports, health checks, GitHub webhooks, and unknown routes carry no cross-origin permission.

Requests with a missing, malformed, or unapproved `Host` authority are rejected before CORS headers are selected. This blocks DNS-rebinding pages from turning an attacker-controlled origin into a readable loopback endpoint.
