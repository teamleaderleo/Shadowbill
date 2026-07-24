# Local dashboard

Start the collector:

```bash
npm run serve
```

Open the same-origin dashboard:

```text
http://127.0.0.1:7337/dashboard/
```

The page supports 7, 30, 90, and 365-day presets plus a custom 1–365 day range, inclusive end date, and IANA timezone.

It displays:

- working API-equivalent cost
- visible input and output tokens
- chat turns, capture revisions, and conversations
- retained code tokens and delivered-code floor
- commits, merged pull requests, successful CI runs, and successful deployments
- cost per delivered outcome
- peak usage and estimated-cost days
- a daily cost and chat-volume chart
- reverse-chronological daily ledger rows

## Privacy boundary

The collector serves the HTML, CSS, and JavaScript itself. The page fetches `/v1/report` from the same loopback origin and makes no third-party requests.

Dashboard responses include a strict Content Security Policy, frame denial, same-origin resource policy, referrer suppression, and browser capability restrictions. They carry no CORS headers.

The collector validates the HTTP `Host` authority before serving the page. Reverse-proxy deployments must configure an explicit allowed host as described in [`http-security.md`](http-security.md).
