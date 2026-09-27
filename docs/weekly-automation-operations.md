# Weekly Automation Operations

All Phase 1 control endpoints are protected by the existing Cloudflare Access and approved-email checks.

## View Status

```text
GET /sync-status
GET /sync-status?week_start=YYYY-MM-DD
```

The response includes the latest run, selected week, current or failed step, retry count, source statuses, and final completeness.
It also includes the Workflow retry/timeout matrix.

## Manually Sync A Week

```text
POST /sync-week?week_start=YYYY-MM-DD
POST /sync-week
POST /sync-week?week_start=latest
```

Rules:

- `week_start` must be a Sunday.
- The week must be fully completed in `Africa/Cairo`.
- A completed run is not rerun automatically.
- Missing `week_start` and `week_start=latest` resolve to the latest fully completed Cairo Sunday-Saturday week.
- Same-week writes use the existing Sheet replacement/upsert helpers.
- If the selected run is failed or incomplete, `/sync-week` retries that same run safely instead of creating a duplicate.

Run sequence:

1. GA4 sync
2. Verify GA4 completion
3. Meta sync
4. Verify Meta completion
5. Shopify sync
6. Verify Shopify completion
7. Rebuild `ReportWeekly`
8. Rebuild `ReportActions`
9. Verify final report completeness
10. Mark the run complete

## Retry A Failed Run

```text
POST /sync-retry?run_id=...
```

Retry works only for failed or incomplete runs. It preserves the original week, increments `retry_count`, clears the previous error, and reruns the same ordered sequence.

Completed source statuses are preserved. On retry, GA4, Meta, and Shopify steps verify their existing Sheet rows first and skip refetching when the source is already complete and valid.

## Retry And Timeout Matrix

| Step | Workflow retries | Delay/backoff | Timeout |
| --- | ---: | --- | --- |
| initialize lock | 3 | 5 seconds, exponential | 2 minutes |
| GA4 sync | 3 | 30 seconds, exponential | 30 minutes |
| GA4 verify | 3 | 10 seconds, linear | 5 minutes |
| Meta sync | 3 | 30 seconds, exponential | 30 minutes |
| Meta verify | 3 | 10 seconds, linear | 5 minutes |
| Shopify sync | 3 | 45 seconds, exponential | 30 minutes |
| Shopify verify | 3 | 10 seconds, linear | 5 minutes |
| ReportWeekly rebuild | 3 | 20 seconds, exponential | 15 minutes |
| ReportActions rebuild | 3 | 20 seconds, exponential | 15 minutes |
| final verification | 3 | 10 seconds, linear | 5 minutes |
| mark complete | 3 | 5 seconds, linear | 2 minutes |

Provider calls also retry transient HTTP 429, selected transient 4xx, HTTP 5xx, and network failures. Permanent auth/configuration failures fail clearly and remain retryable after configuration is fixed.

## Diagnose Failures

- `ga4_sync` or `ga4_verify`: check GA4 property id, Google credentials, and `GA4Weekly`.
- `meta_sync` or `meta_verify`: check Meta token/account access and `MetaWeekly`.
- `shopify_sync` or `shopify_verify`: check Shopify token/scopes and `ShopifyWeekly`.
- `report_weekly_rebuild`, `report_actions_rebuild`, or `final_report_verify`: check required source rows for the selected week.

The UI displays failed or partial status with failed step, short error message, and last updated time. It does not expose secrets, tokens, private keys, or stack traces.

## Disable Cron Safely

Remove or comment the `[triggers]` block in `wrangler.toml`, then deploy the existing `shopify-sync` Worker. Manual endpoints remain available.

## Rollback

1. Roll back Worker code to the pre-Phase-1 checkpoint commit.
2. Remove the `[triggers]` and `[[d1_databases]]` additions if the old code is deployed.
3. Leave Google Sheets unchanged.
4. Keep the D1 database for audit, or export it before deleting.
5. Confirm `/report-data` still works through Cloudflare Access.

Pre-Phase-1 checkpoint:

```text
0388bbf Checkpoint secured report baseline
```

## Confirm No Duplicate Rows

For a retried week, inspect these tabs and confirm one logical set of rows for `week_start`:

- `GA4Weekly`
- `GA4ProductWeekly`
- `MetaWeekly`
- `MetaCampaignWeekly`
- `MetaAdWeekly`
- `ShopifyWeekly`
- `ShopifyProductWeekly`
- `ShopifySkuWeekly`
- `ShopifyInventorySnapshot`
- `ShopifyProductDiagnosis`
- `ShopifySkuDiagnosis`
- `ReportWeekly`
- `ReportActions`

The weekly tabs use upsert/replacement by `week_start`; detail tabs replace rows for the selected week.
