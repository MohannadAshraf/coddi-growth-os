# Fresh Rebuild Validation

This checklist rebuilds the trusted baseline without changing the approved later-phase roadmap.

## Scope

Rebuild these completed Sunday-start weeks only:

- `2026-05-03`
- `2026-05-10`
- `2026-05-17`
- `2026-05-24`
- `2026-05-31`

The reporting timezone is `Africa/Cairo`. Weeks run Sunday through Saturday, so `2026-05-31` ends on `2026-06-06`.

## Sheet Tabs

Preserve the `Config` tab and all tab headers. Clear data rows only for these generated tabs when doing a full clean rebuild:

- `ShopifyWeekly`
- `ShopifyProductWeekly`
- `ShopifySkuWeekly`
- `ShopifyInventorySnapshot`
- `ShopifyProductDiagnosis`
- `ShopifySkuDiagnosis`
- `GA4Weekly`
- `GA4ProductWeekly`
- `MetaWeekly`
- `MetaCampaignWeekly`
- `MetaAdWeekly`
- `ReportWeekly`
- `ReportActions`
- `SyncMeta`

Do not clear `Config`. Do not change headers unless the code is changed in the same deployment.

## Execution Order

Run each week in this exact order:

1. `GET /sync-ga4-week?week_start=YYYY-MM-DD`
2. Confirm `GA4Weekly` and `GA4ProductWeekly` rows exist for that week.
3. `GET /sync-meta-week?week_start=YYYY-MM-DD`
4. Confirm `MetaWeekly`, `MetaCampaignWeekly`, and `MetaAdWeekly` rows exist for that week.
5. `GET /sync-shopify-all?week_start=YYYY-MM-DD`
6. Confirm Shopify tabs were rebuilt.
7. Confirm `ReportWeekly` and `ReportActions` were rebuilt from the already-synced GA4 and Meta rows.

Do not run Shopify before GA4 and Meta for a week unless intentionally validating partial-report behavior.

## Shopify Validation

For each week, compare Worker output and Sheet rows against Shopify Admin reports:

- `gross_sales`
- `discounts`
- `refunds`
- `net_sales`
- `shipping_revenue`
- `taxes`
- `total_sales`
- `orders`
- `total_quantity_ordered`
- `net_items_sold`
- `returned_items`
- product/SKU units sold
- ending inventory units
- stockout sold SKU count

Top-level commercial values should continue to use ShopifyQL where the Worker already does so.

## GA4 Validation

For each week, verify:

- `sessions`
- `users`
- `engaged_sessions`
- `view_item_events`
- `add_to_cart_events`
- `begin_checkout_events`
- `purchase_events`
- `item_views`
- `items_added_to_cart`
- `items_checked_out`
- `items_purchased`
- `GA4ProductWeekly` rows are filtered to the selected week.

## Meta Validation

For each week, verify:

- account spend, impressions, reach, clicks, link clicks, LPVs
- purchases and purchase value
- campaign rows by campaign ID
- ad rows by ad ID
- video hook/hold metrics only drive video diagnosis for genuine video-like rows
- catalogue, catalog, carousel, dynamic, collection, and ASC-like ads are excluded from genuine-video hook diagnosis

## ReportWeekly Formula Checks

For each week, verify:

- `week_start` and `week_end` are correct.
- `report_status` reflects missing or present Shopify, GA4, and Meta rows.
- `mer = shopify_net_sales / meta_spend` when Meta spend is present.
- `blended_cac = meta_spend / shopify_orders` when orders are present.
- prior-week comparisons use the immediately previous completed week.
- four-week averages use the previous four completed weeks, excluding the report week.
- missing GA4 or Meta rows produce partial status and warnings instead of crashes.

## ReportActions Checks

For each week, verify:

- action IDs are scoped to the selected week.
- rerunning the same week replaces that week's actions.
- other weeks' actions remain untouched.
- blank rows are not introduced.
- missing GA4 or Meta rows produce source-data actions instead of silent failure.

## Report API And UI Checks

For each rebuilt week:

1. Call `/report-data?week_start=YYYY-MM-DD` with Cloudflare Access authentication.
2. Confirm all returned data is filtered to that week.
3. Confirm `week.week_start`, `week.week_end`, and `warnings` are correct.
4. Open `https://your-report-ui.pages.dev/report?week_start=YYYY-MM-DD`.
5. Confirm the UI loads, shows the same week range, shows caveats for missing rows, and does not expose raw internal errors.

## Rollback

If a rebuild produces incorrect report data:

1. Stop further rebuilds.
2. Export or copy the affected tabs for audit.
3. Restore from the last known-good Sheet version or Cloudflare deployment.
4. Re-run the affected week in GA4 -> Meta -> Shopify order after fixing the cause.
5. Re-check `/report-data` and the report UI before continuing.
