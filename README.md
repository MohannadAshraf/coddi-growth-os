# Growth OS — weekly performance pipeline for a Shopify apparel brand

A Cloudflare Workers pipeline that pulls **Shopify, Meta Ads and GA4** into a single
warehouse, reconciles them, and serves a weekly performance report and growth dashboard
behind Cloudflare Access. Built for a Cairo streetwear brand on a seasonal drop model.

> Public, sanitized copy. All store identifiers, credentials, account IDs and business
> figures have been removed or replaced with synthetic values.

## What it does
- **Ingestion**: scheduled syncs from the Shopify Admin API / ShopifyQL, Meta Marketing API
  and GA4 Data API, orchestrated with Cloudflare Workflows, with bounded retries and
  per-provider error handling.
- **Warehouse**: Cloudflare D1 (32 versioned SQL migrations) plus R2 snapshots taken
  before every rewrite, so no sync can silently destroy history.
- **Metric layer**: typed metric definitions (`growth-os/definitions.js`) with an explicit
  basis and settledness for every number, e.g. measured vs estimated margin, provisional vs
  settled revenue, and COD return-to-origin (RTO) costs.
- **Drop-aware analysis**: comparisons normalised to days-since-drop instead of calendar
  weeks, to avoid false alarms in post-drop decay weeks.
- **Attribution**: a Shopify theme snippet that writes click IDs and UTMs onto orders,
  joined to ad-level spend for delivered cost-per-order.
- **Reporting UI**: Cloudflare Pages front end (`report-ui/`) proxied to the Worker, with
  Cloudflare Access JWT verification on the API routes.
- **Monitoring**: Meta prepaid-funds runway monitor with Telegram alerts.

## Stack
Cloudflare Workers · Workflows · D1 · R2 · Pages · Access · Shopify Admin GraphQL /
ShopifyQL · Meta Marketing API · GA4 Data API · Node test runner (422 tests)

## Run the tests
```bash
npm install
npm test
```

## Configure
Copy the placeholders in `wrangler.toml` to your own values and set secrets with
`wrangler secret put` (Shopify token, Meta token, Google service-account key, OpenAI key,
Telegram bot token). See `docs/` for setup, security and operations notes.
