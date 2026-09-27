# CLAUDE.md — coddi-report-worker

Weekly performance reporting pipeline for Coddiwomple (Cairo streetwear, Shopify).
Cloudflare Worker + Workflows + D1. Syncs Shopify, GA4, and Meta into Google Sheets,
then builds a diagnosis + scored-action + AI report layer on top.

## Business model — read this before changing any comparison logic

**Revenue is drop-driven, not calendar-driven.** Each product drop causes a spike,
then decays over 3–4 weeks toward a baseline floor. Confirmed across every drop in
the summer 2026 season.

Consequence: **week-over-week and trailing-4-week comparisons produce false alarms
every post-drop week.** Any diagnosis that says "sales dropped, investigate conversion"
during weeks 1–3 after a drop is almost certainly noise. Comparisons must eventually
normalise to `days_since_drop`, not calendar weeks.

Drop dates (2026): Apr 1, Apr 21, May 14, Jun 16, Jun 29, Jul 26, **Sep 20 (winter W1)**.

Other facts that affect interpretation:
- COD is a large share of orders. Ordered revenue is not money. RTO is real cost.
- COGS is not currently in the system. Every "margin" signal is a proxy (MER, ROAS,
  discounts, refunds). Never present a proxy as margin.
- A sitewide automatic discount ran from late June through Sep 20. Any comparison
  spanning that window is contaminated.

## Stack

- Cloudflare Workers, single entry: `src/worker.js` (large, ~7k lines, intentionally flat)
- Cloudflare Workflows (`WeeklySyncWorkflow`) for the weekly orchestration
- D1 (`SYNC_DB`) for run state, goals, mappings, creative metadata, funds monitor
- Google Sheets as the current fact store (being migrated to D1)
- Shopify Admin GraphQL + ShopifyQL, GA4 Data API, Meta Marketing API, OpenAI Responses API
- No build step, no bundler, no framework. Plain ES modules.

## Non-negotiables

1. **Never print, log, echo, or return a secret.** All credentials come from
   `wrangler secret put`. When adding diagnostics, follow the existing
   `redactMetaDiagnosticText` / `redactMonitorSecrets` pattern.
2. **Never fabricate data.** This codebase's entire design philosophy is that missing
   data is reported as missing. Use `metricOrBlank()` — not `0` — when a value is
   absent. A blank cell is correct; a fabricated zero is a bug.
3. **Never widen a `clear` operation.** See "Landmines" below.
4. **State the subrequest count** of any change before writing the code. This Worker is
   on **Workers Paid**: the ceiling is 10,000 subrequests per invocation (raised from
   1,000 in Feb 2026), configurable up to 10M via `limits.subrequests` in `wrangler.toml`.
   Each Workflow step is its own invocation with its own budget, and calls to R2, KV, and
   D1 count as subrequests alongside `fetch`.

   Subrequests are **no longer the binding constraint** — state the count so the trend
   stays visible, but the limits that actually bite now are **CPU time** and the
   **128 MB memory ceiling**. `readAllTabs` pulls the entire warehouse into memory on
   every request; anything that copies or serialises that structure (`JSON.stringify`,
   a full array `map`) briefly doubles it. Budget memory before subrequests.

   Historical note: weeks 2026-07-19, 07-26 and 08-02 failed on the old 50-subrequest
   free-plan limit. Any code or comment citing a "Free Worker limit" predates the plan
   change and is obsolete — see `syncBackfill`.
5. **Don't add dependencies.** If one seems necessary, ask first.

## Conventions — use the existing helpers, always

| Instead of | Use | Why |
|---|---|---|
| `Number(x)` | `num(x)` | Handles `""`, `null`, commas, `%` suffixes |
| `String(x).trim()` | `clean(x)` | Null-safe |
| `a / b` | `div(a, b)` | Returns `""` on zero denominator, not `Infinity` |
| `Math.round(x*100)/100` | `r2(x)` / `r4(x)` | Consistent rounding, blank-safe |
| raw money access | `money(bag)` | Extracts `shopMoney.amount` |
| `x \|\| 0` for metrics | `metricOrBlank(x)` | Preserves "no data" vs "zero" |

**Never compare an identifier Google echoed back to a locally-built string with `===`.**
Sheets resolves tab titles case-insensitively but answers with its own spelling, so an
exact match silently fails. Use `sameSheetName`. This is live: the sheet's tab is
`ShopifySkuDIagnosis` (capital I) while every code path spells it `ShopifySkuDiagnosis`.
An `===` check marked that tab's write unconfirmed and skipped its trim, leaving 7 stale
rows on real data. The same rule covers `updatedRange`, `properties.title`, and tab names
parsed out of error messages.

**Never gate logic on Sheets' `updatedRows`.** It counts rows where at least one cell
changed, and this codebase writes blank cells deliberately (`metricOrBlank`), so an
all-blank row is not counted and a correctly written tab reports short. Use
`updatedRange`. Keep `updatedRows` as a logged diagnostic only.

**Both endpoints of a constructed range must come from values read off the sheet.**
Sheets clamps a fully unbounded range (`A:ZZ`) but *rejects* one with an explicit start
row past the last row, so `A{n+1}:ZZ` breaks the moment a tab fills its grid. Bound row
ends with `oldLen` and column ends with `colLetter(...)`, never `ZZ`.

**`keep_vars = true` is set in `wrangler.toml`.** Deleting a var from that file does
**not** remove it from the deployed Worker — it is retained and inherited by every later
version. Pin simulation and test flags to an explicit `"false"` with a comment; never
delete the line. Before any promotion, assert no simulation flag is set: check the
bindings printed by `wrangler versions upload`.

**Mocks must not mirror their inputs.** Both live bugs found during P0.3 were invisible to
tests because the fetch mock echoed the request back — identical names by construction, and
no grid, so neither the case mismatch nor the range-limit failure was reachable. The Sheets
fake in `test/baseline.test.js` now resolves titles against a canonical fixture and enforces
real row and column bounds. Keep it that way.

Other patterns to follow:
- Sheet rows are objects keyed by the `HEADERS` arrays. Add a column by adding it to
  `HEADERS` **and** to the row builder. Order matters.
- Provider calls go through `retryingFetch` (or `shopifyGraphQL` for Shopify), never
  bare `fetch`. Backoff, permanence classification, and Retry-After are handled there.
- Errors that should not be retried by a Workflow step must go through
  `throwWorkflowError` so `NonRetryableError` is raised correctly.
- Weeks start **Sunday**, timezone **Africa/Cairo**, and only **completed** weeks sync.
  Use `weekBoundaries`, `assertCompletedWeek`, `latestCompletedSundayWeekStart`.
  Never hand-roll date maths — use `addDays` / `dateOnlyToUtcMs` / `formatDateOnlyFromUtcMs`.

## Version constants — bump these when logic changes

`RECOMMENDATION_ENGINE_VERSION`, `RECOMMENDATION_PROMPT_VERSION`,
`ELIGIBILITY_RULE_VERSION`, `EVIDENCE_SCHEMA_VERSION`, `AI_REPORT_PACK_VERSION`,
`AI_REPORT_PROMPT_VERSION`, `GOAL_SCHEMA_VERSION`.

`supersedePriorRecommendationVersions` uses these to invalidate stored audit rows.
Changing scoring, eligibility, or prompt behaviour **without** bumping the matching
constant silently mixes old and new outputs in the same tables.

`GROWTH_OS_CONTRACT_VERSION` — bump when the `/growth/*` response shape or the
metric envelope changes. A metric's *meaning* is versioned separately, in
`metric_definitions` (see below), never by this constant.

## Growth OS (`/growth/*`) — read GROWTH-OS-SESSION-1-SPEC.md first

- Every number is built by `metricEnvelope()`. No surface builds its own; the UI
  renders through `report-ui/growth-envelope.js` only.
- Metric meaning lives in `growth-os/definitions.js` → generated seed migration.
  Run `node growth-os/generate.js` after editing; `npm test` fails on drift.
  Redefining a metric = new row, `version + 1`, later `effective_from`, new
  `migration` tag. Never edit a definition in place.
- **Never edit an applied migration.** `growth-os/applied-migrations.json` pins the
  hash of every migration applied to production D1; add a new migration instead,
  and record its hash after `wrangler d1 migrations apply --remote`.
- Computation lives in `GROWTH_RESOLVERS`. Unwired = `missing`, which is correct.
- `/growth/*` reads are D1-only: one `batch()` per request. No `readAllTabs`, no
  provider call — a test enforces it.
- CHECK constraints only for invariants. Enumerations are validated in code.
- Comparisons come only from `dropDayComparison` / `floorPoolComparison`, and resolvers
  reach them only through `dropCycleComparison`, which picks the mode from the drop
  context (floor pool from drop-day 21). Never build a comparison by hand.
- The UI design is ported from the Claude Design project "Growth OS Visual System"
  (tokens in `report-ui/growth.css`). No React / dc-runtime: plain HTML strings.
- Deploy the UI with `npm run deploy:ui` only. `wrangler pages deploy` picks up
  `functions/` (the API proxy), `_headers` and `_redirects` from the directory it
  runs in; run from the repo root it ships the pages without them and every
  `/growth/*` call 404s (happened 2026-09-15, ~10 minutes).
- Growth OS writers run nightly after the inventory snapshot, in order: orders,
  Shopify sessions, Meta; `POST /growth/load` runs the same on demand.

## Landmines

### 1. Clear-then-write — FIXED, keep it that way

Historically `syncShopifyAll`, `syncMetaWeek`, and `syncGA4Week` called `batchClearTabs`
then `batchWriteRanges` — two network calls, no transaction, so a failed write
permanently destroyed every historical row in those tabs. Nine tabs in the Shopify case.

Both fixes have landed. **P0.1**: an R2 snapshot of exactly the tabs about to be replaced
is written first (`snapshotTabsBeforeRewrite`, bucket `coddi-report-snapshots`, 90-day
lifecycle). **P0.3**: clear-then-write is gone, replaced by write-then-trim in
`rewriteTabs`, which is now the single mutation path for all five rewrite sites.

**`batchClearTabs` no longer exists, and must not come back.** There is deliberately no
whole-tab clear helper in this file. The only clear is `batchClearRanges`, called once,
inside `rewriteTabs`, after the write is confirmed. If you need to change how a tab is
rewritten, change `rewriteTabs` — do not add a clear at a call site.

Rules that keep this working:
- Trim only tabs the write response confirms. Confirmation gates on the end row parsed
  from `updatedRange`, **never** on `updatedRows` — this codebase writes blank cells
  deliberately, and Google does not count a row whose cells did not change.
- Every write must be a **complete rewrite** of its tab. `ReportWeekly` and
  `ReportActions` are each written by two sites, which is safe only because all four
  writes emit full history. A partial-range write to any rewritten tab would break
  always-trim and delete rows the write never replaced.
- `allowEmpty: false` means "empty is a bug" and raises `NonRetryableError`. It belongs
  only on tabs built from an unconditional row (`ShopifyWeekly`, `ReportWeekly`,
  `SyncMeta`, `MetaWeekly`, `GA4Weekly`). Every `replaceObjectsForWeek` target sets
  `allowEmpty: true` — a quiet week legitimately produces zero rows, and turning that
  into a hard failure creates permanent `failed` rows in `weekly_sync_runs`.
- Trim failures raise a plain `Error` so the Workflow retries and the rewrite self-heals.
  Do not route them through `throwWorkflowError`.

Still outstanding: migrate the store to D1 (P2.1).

### 2. Refund reconciliation is computed then discarded

`syncShopifyAll` runs `collectRefundAdjustmentsFromOrders` and
`applyRefundAdjustmentsToAggregate`, then immediately overwrites the eight weekly
financial fields with ShopifyQL values. The refund logic survives only at product/SKU
level. Don't "fix" one side without deciding which is authoritative.

### 3. Meta status is always empty

`fetchMetaCampaignStatuses` and `fetchMetaAdStatuses` exist but are never called —
`syncMetaWeek` creates empty Maps. Downstream, `paidSupportSummary` counts
`active_ads` by filtering on status, so **paused and archived ads count as active**.
Any "active ads" figure in Product Intelligence is currently wrong.

### 4. `DIAGNOSIS_THRESHOLDS` is hardcoded to the wrong business

`working_add_to_cart_rate: 0.08` against the actual sitewide ATC rate means almost
every product classifies as demand-constrained. `productSampleStats` already computes
percentiles — thresholds should be derived from the store's own distribution, not
frozen constants.

### 5. Every read pulls the whole warehouse

`buildReportData` calls `readAllTabs` (15 ranges, full history). So do `/report`,
`/report-data`, `/diagnosis`, `/scored-actions`, `/ai-report`, `/creative-metadata`,
and `/ad-product-mappings`. One dashboard load re-reads everything, repeatedly.

### 6. `/ad-preview` returns raw third-party HTML

Meta's `preview_html` is returned unsanitised. If the Pages UI renders it via
`innerHTML`, arbitrary HTML executes in an authenticated origin. Sandbox in an iframe
or don't render it.

### 7. Dead code — don't extend it

- `orderShippingDiscountFromApplications` — no call site
- `summarizeSalesAgreementsForDebug` — reads `order.agreements`, which no query fetches
- `fetchOrdersInRange` is called twice per sync with overlapping windows (weekly, then
  30-day rolling). Fetch 30 days once and filter in memory.

## Cron schedule

```
"1 21,22 * * SAT"   # weekly sync — dual UTC times, gated to the Sunday
                    # 00:00–00:20 Africa/Cairo window by cairoWeeklyCronDecision.
                    # This is correct DST handling. Do not "simplify" it.
"*/30 * * * *"      # Meta funds monitor
"50 20,21 * * *"    # daily inventory snapshot — dual UTC times, gated to 23:30–23:59
                    # Africa/Cairo by inventorySnapshotCronDecision. The other firing
                    # lands at 00:50 or 22:50 and must skip, or it would stamp the next
                    # day's immutable row with the wrong stock.
```

`scheduled()` dispatches on `controller.cron`. Adding a cron means adding a branch
**before** the weekly one, which treats any unrecognised cron as its own. A changed
`crons` list needs `npx wrangler triggers deploy` — `versions deploy` does not apply it.

## Testing

- `wrangler dev` for local; `REPORT_AUTH_LOCAL_DEV=true` bypasses Cloudflare Access
- `wrangler tail` for live logs after deploy
- Diagnostic endpoints under `/debug-*` are already extensive — check for an existing
  one before writing a new script
- `/health` for a liveness check

## Definition of done

- Subrequest count stated
- Failure modes named
- No new secret exposure
- Version constant bumped if scoring/eligibility/prompt logic changed
- Rollback note for anything touching sync, clear, or write paths
