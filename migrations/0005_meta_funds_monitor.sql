PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta_funds_monitor_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  status TEXT NOT NULL DEFAULT 'setup_required',
  active_calibration_id TEXT,
  fixed_reserve_minor INTEGER NOT NULL DEFAULT 50000 CHECK (fixed_reserve_minor >= 0),
  reserve_percentage_bps INTEGER NOT NULL DEFAULT 1500 CHECK (reserve_percentage_bps BETWEEN 0 AND 10000),
  fallback_daily_spend_minor INTEGER NOT NULL DEFAULT 750000 CHECK (fallback_daily_spend_minor >= 0),
  settlement_grace_minutes INTEGER NOT NULL DEFAULT 15 CHECK (settlement_grace_minutes BETWEEN 0 AND 1440),
  recharge_rounding_minor INTEGER NOT NULL DEFAULT 100000 CHECK (recharge_rounding_minor > 0),
  previous_velocity_max_age_minutes INTEGER NOT NULL DEFAULT 360 CHECK (previous_velocity_max_age_minutes > 0),
  last_confirmed_cursor_utc TEXT,
  last_activity_sync_utc TEXT,
  activity_sync_complete INTEGER NOT NULL DEFAULT 0 CHECK (activity_sync_complete IN (0,1)),
  lock_owner TEXT,
  lock_expires_utc TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta_funds_calibrations (
  calibration_id TEXT PRIMARY KEY,
  calibrated_funds_minor INTEGER NOT NULL CHECK (calibrated_funds_minor >= 0),
  api_balance_minor INTEGER NOT NULL CHECK (api_balance_minor >= 0),
  currency TEXT NOT NULL,
  account_status INTEGER,
  disable_reason INTEGER,
  timezone_name TEXT NOT NULL,
  calibrated_at_utc TEXT NOT NULL,
  calibrated_at_cairo TEXT NOT NULL,
  activity_boundary_utc TEXT NOT NULL,
  fallback_daily_spend_minor INTEGER NOT NULL,
  fixed_reserve_minor INTEGER NOT NULL,
  reserve_percentage_bps INTEGER NOT NULL,
  settlement_grace_minutes INTEGER NOT NULL,
  recharge_rounding_minor INTEGER NOT NULL,
  calibration_type TEXT NOT NULL CHECK (calibration_type IN ('initial','recalibration')),
  audit_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS meta_funds_alert_cycles (
  cycle_id TEXT PRIMARY KEY,
  calibration_id TEXT NOT NULL REFERENCES meta_funds_calibrations(calibration_id),
  opened_at_utc TEXT NOT NULL,
  source_event_fingerprint TEXT,
  warning_12h_state TEXT NOT NULL DEFAULT 'pending',
  urgent_6h_state TEXT NOT NULL DEFAULT 'pending',
  critical_2h_state TEXT NOT NULL DEFAULT 'pending',
  coverage_failed_state TEXT NOT NULL DEFAULT 'pending',
  closed_at_utc TEXT,
  UNIQUE(calibration_id, opened_at_utc, source_event_fingerprint)
);

CREATE TABLE IF NOT EXISTS meta_funding_activities (
  event_fingerprint TEXT PRIMARY KEY,
  calibration_id TEXT REFERENCES meta_funds_calibrations(calibration_id),
  event_type TEXT NOT NULL,
  event_time_utc TEXT NOT NULL,
  processed_at_utc TEXT NOT NULL,
  canonical_amount_minor INTEGER,
  wallet_delta_minor INTEGER,
  currency TEXT,
  sanitized_metadata_json TEXT NOT NULL DEFAULT '{}',
  processing_state TEXT NOT NULL CHECK (processing_state IN ('applied','no_wallet_change','review_required','pre_calibration')),
  processing_confidence TEXT NOT NULL,
  cycle_id TEXT REFERENCES meta_funds_alert_cycles(cycle_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_funding_activities_time ON meta_funding_activities(event_time_utc DESC);
CREATE INDEX IF NOT EXISTS idx_meta_funding_activities_calibration ON meta_funding_activities(calibration_id, event_time_utc);

CREATE TABLE IF NOT EXISTS meta_funds_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  calibration_id TEXT NOT NULL REFERENCES meta_funds_calibrations(calibration_id),
  cycle_id TEXT REFERENCES meta_funds_alert_cycles(cycle_id),
  captured_at_utc TEXT NOT NULL,
  current_balance_minor INTEGER NOT NULL,
  estimated_wallet_minor INTEGER NOT NULL,
  operational_reserve_minor INTEGER NOT NULL,
  risk_adjusted_coverage_minor INTEGER NOT NULL,
  normalized_interval_spend_minor INTEGER,
  interval_valid INTEGER NOT NULL CHECK (interval_valid IN (0,1)),
  velocity_3h_minor_per_hour INTEGER,
  velocity_6h_minor_per_hour INTEGER,
  velocity_24h_minor_per_hour INTEGER,
  effective_velocity_minor_per_hour INTEGER,
  velocity_source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  runway_minutes INTEGER,
  recommended_recharge_exact_minor INTEGER,
  recommended_recharge_rounded_minor INTEGER,
  activity_sync_complete INTEGER NOT NULL CHECK (activity_sync_complete IN (0,1)),
  monitor_status TEXT NOT NULL,
  account_status INTEGER,
  disable_reason INTEGER,
  settlement_until_utc TEXT,
  warning_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_meta_funds_snapshots_time ON meta_funds_snapshots(captured_at_utc DESC);

CREATE TABLE IF NOT EXISTS meta_funds_alert_deliveries (
  delivery_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  cycle_id TEXT NOT NULL REFERENCES meta_funds_alert_cycles(cycle_id),
  snapshot_id TEXT NOT NULL REFERENCES meta_funds_snapshots(snapshot_id),
  severity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved','sent','failed','skipped')),
  attempted_at_utc TEXT NOT NULL,
  delivered_at_utc TEXT,
  sanitized_result TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_meta_funds_alert_deliveries_time ON meta_funds_alert_deliveries(attempted_at_utc DESC);

CREATE TABLE IF NOT EXISTS meta_funds_monitor_runs (
  run_id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  started_at_utc TEXT NOT NULL,
  finished_at_utc TEXT,
  status TEXT NOT NULL,
  lock_owner TEXT,
  query_since_utc TEXT,
  query_until_utc TEXT,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  activities_seen INTEGER NOT NULL DEFAULT 0,
  activities_inserted INTEGER NOT NULL DEFAULT 0,
  synchronization_complete INTEGER NOT NULL DEFAULT 0,
  sanitized_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_meta_funds_monitor_runs_time ON meta_funds_monitor_runs(started_at_utc DESC);

INSERT OR IGNORE INTO meta_funds_monitor_settings (singleton_id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
