# Report Security Setup

The report frontend is hosted at:

- `https://your-report-ui.pages.dev`
- example report: `https://your-report-ui.pages.dev/report?week_start=2026-05-31`

The browser-facing API is now on the same Pages origin:

- `https://your-report-ui.pages.dev/api/report-data`

Pages Functions forwards `/api/*` to the `shopify-sync` Worker through the
`REPORT_API` service binding. The browser no longer depends on a
`workers.dev` authorization cookie.

## What The Repository Now Enforces

- `/report-data` no longer returns data without Cloudflare Access authentication.
- `/report-data` validates the Cloudflare Access JWT signature and audience when configured.
- `/report-data` only allows approved report origins, defaulting to `https://your-report-ui.pages.dev`.
- `/report-data` sends `Cache-Control: private, no-store`.
- The Pages proxy forwards the Pages Access assertion to the Worker.
- The Worker accepts only the known Pages and Worker application audiences, then checks the approved-email allowlist.
- The report UI calls `/api/*` on its own origin, so one Pages Access login covers the page and its data requests.
- No browser-delivered file contains an API key, shared secret, password, or bearer token.
- Local development requires an explicit `.dev.vars` bypass and is not enabled by checked-in config.

## Required Worker Variables

Configure these on the Worker:

- `REPORT_ALLOWED_ORIGINS=https://your-report-ui.pages.dev`
- `REPORT_ALLOWED_EMAILS=owner@example.com,reviewer@example.com`
- `CF_ACCESS_TEAM_DOMAIN=<your-team-name>.cloudflareaccess.com`
- `CF_ACCESS_AUD=<Worker API audience tag>,<Pages application audience tag>`

Optional override:

- `CF_ACCESS_CERTS_URL=https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs`

Local development only, in `.dev.vars`:

```txt
REPORT_AUTH_LOCAL_DEV=true
REPORT_ALLOWED_ORIGINS=http://localhost:8787,http://127.0.0.1:8787,http://localhost:5173,http://127.0.0.1:5173
```

Do not set `REPORT_AUTH_LOCAL_DEV=true` in production.

## Cloudflare Access Dashboard Steps

Keep both Access applications. The Pages application is the browser login and
the Worker application protects direct Worker requests.

### Frontend Application

1. Go to Cloudflare Zero Trust -> Access -> Applications.
2. Add a self-hosted application for `your-report-ui.pages.dev`.
3. Policy: Allow only `owner@example.com` and `reviewer@example.com`.
4. Enable session duration appropriate for report access.
5. Confirm anonymous browser access redirects to Cloudflare Access before the report loads.

### Direct Worker Application

1. Add a self-hosted application for `shopify-sync.your-subdomain.workers.dev`.
2. If possible, scope the path to `/report-data*`. If this `workers.dev` host cannot be protected or path-scoped in your Cloudflare dashboard, move the report API to a Cloudflare-managed custom hostname before treating it as private.
3. Policy: Allow only `owner@example.com` and `reviewer@example.com` for report API access.
4. Add the Worker audience tag and the Pages audience tag to `CF_ACCESS_AUD` as a comma-separated list.
5. In Advanced settings -> Cross-Origin Resource Sharing, allow or bypass `OPTIONS` requests so browser preflight can reach the Worker CORS response.
6. Confirm anonymous `/report-data?week_start=2026-05-31` is denied or redirected by Access.

### Pages Service Binding

The checked-in `report-ui/wrangler.toml` binds `REPORT_API` to `shopify-sync`.
Deploy Pages with that configuration so `/api/*` invokes the Worker directly.
Do not replace the proxy with browser-side cross-origin fetches.

## Acceptance Tests

Run after deployment and Access configuration:

1. Anonymous `https://your-report-ui.pages.dev/report?week_start=2026-05-31` redirects to Access or is denied.
2. Anonymous `https://shopify-sync.your-subdomain.workers.dev/report-data?week_start=2026-05-31` is denied or redirected.
3. Signed-in `owner@example.com` and `reviewer@example.com` can load the report UI and `/api/report-weeks` after one login.
4. The report page makes no browser request to `workers.dev`.
5. A request with `Origin: https://evil.example` does not receive `Access-Control-Allow-Origin` from the Worker.
6. `/api/report-data` responses include `Cache-Control: private, no-store`.
7. Searching `report-ui` source shows no API key, shared secret, password, or bearer token.

## Current Limitation

The Access applications and policies remain Cloudflare account resources. Keep
their audience tags aligned with `CF_ACCESS_AUD`, and repeat the anonymous-denial
tests after any Access application replacement.
