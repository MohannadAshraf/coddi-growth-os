# Weekly Automation Setup

Phase 1 adds operational run state only. Google Sheets remains the source of truth for Shopify, GA4, Meta, `ReportWeekly`, and `ReportActions`.

## Cloudflare Resources

The production Worker must remain `shopify-sync`. Do not create or deploy a second Worker.

Create the D1 database:

```powershell
$env:PATH = 'C:\tmp\node-v24.17.0-win-x64;' + $env:PATH
.\node_modules\.bin\wrangler.cmd d1 create coddi-report-sync-state
```

Copy the returned `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "SYNC_DB"
database_name = "coddi-report-sync-state"
database_id = "<REAL_D1_DATABASE_ID>"
migrations_dir = "migrations"
```

Apply the migration:

```powershell
.\node_modules\.bin\wrangler.cmd d1 migrations apply coddi-report-sync-state --remote
```

The migration is `migrations/0001_weekly_sync_runs.sql`. It creates only `weekly_sync_runs`.

## Cron

`wrangler.toml` uses:

```toml
[triggers]
crons = ["1 21,22 * * SAT"]
```

Cloudflare Cron runs in UTC. The Worker gates execution using `Africa/Cairo` local time and only starts when local time is Sunday between `00:00` and `00:20`. The reporting week is the previous Sunday through Saturday.

## Workflow Binding

Phase 1 uses a real Cloudflare Workflow. The Cron handler only resolves Cairo time, claims the D1 run, creates the Workflow instance, and returns.

```toml
[[workflows]]
name = "coddi-weekly-sync"
binding = "WEEKLY_SYNC_WORKFLOW"
class_name = "WeeklySyncWorkflow"
```

The Workflow class is exported from `src/worker.js` as `WeeklySyncWorkflow`. It runs granular durable steps:

1. Initialize/lock run
2. GA4 sync
3. GA4 verification
4. Meta sync
5. Meta verification
6. Shopify sync
7. Shopify verification
8. `ReportWeekly` rebuild
9. `ReportActions` rebuild
10. Final completeness verification
11. Mark complete

Each step has its own Workflow retry/timeout configuration. External API calls also have provider-specific bounded retry handling for transient 429/5xx/network failures.

## Deployment Order

1. Confirm `wrangler.toml` still has `name = "shopify-sync"` and `keep_vars = true`.
2. Create the D1 database.
3. Replace the placeholder `database_id`.
4. Apply the D1 migration remotely.
5. Run local tests and `wrangler deploy --dry-run`.
6. Review the diff and confirm no secrets were added to frontend files.
7. Deploy `shopify-sync`.
8. Deploy `report-ui` to the existing Pages project.

## First Run Verification

After deployment, check:

```text
GET /sync-status
GET /report-weeks
POST /sync-week?week_start=YYYY-MM-DD
POST /sync-week
POST /sync-week?week_start=latest
```

Use a completed Sunday `week_start`. Confirm `weekly_sync_runs` shows one run for that week and Sheets rows were replaced for the selected week, not duplicated.
