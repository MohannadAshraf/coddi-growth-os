CREATE TABLE IF NOT EXISTS weekly_sync_runs (
  run_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL UNIQUE,
  week_start TEXT NOT NULL UNIQUE,
  week_end TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  current_step TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  step_attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT NOT NULL DEFAULT '',
  last_provider_error TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  ga4_status TEXT NOT NULL DEFAULT 'pending',
  meta_status TEXT NOT NULL DEFAULT 'pending',
  shopify_status TEXT NOT NULL DEFAULT 'pending',
  report_status TEXT NOT NULL DEFAULT 'pending',
  rows_written_json TEXT NOT NULL DEFAULT '{}',
  is_complete INTEGER NOT NULL DEFAULT 0,
  partial_reason TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_weekly_sync_runs_week_start
  ON weekly_sync_runs (week_start DESC);

CREATE INDEX IF NOT EXISTS idx_weekly_sync_runs_status
  ON weekly_sync_runs (status, updated_at DESC);
