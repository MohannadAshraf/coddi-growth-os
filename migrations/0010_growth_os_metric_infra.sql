PRAGMA foreign_keys = ON;

-- Growth OS L0 — metric infrastructure (GROWTH-OS-SESSION-1-SPEC.md §3).
--
-- Meaning lives here; computation lives in code (GROWTH_RESOLVERS). A metric with
-- no definition row in effect for the requested week fails the request.
-- Source of truth for the seed is growth-os/definitions.js — edit there and run
-- `node growth-os/generate.js`, never hand-edit the generated seed.

CREATE TABLE IF NOT EXISTS metric_definitions (
  metric_key        TEXT NOT NULL,
  version           INTEGER NOT NULL CHECK (version >= 1),
  label             TEXT NOT NULL,
  surface           TEXT NOT NULL,
  unit              TEXT NOT NULL,
  confidence        TEXT NOT NULL,          -- measured | modelled | platform_reported (validated in code)
  formula           TEXT NOT NULL,
  session_basis     TEXT,                   -- shopify | ga4 | NULL when no session enters the metric
  basis_label       TEXT,                   -- what the tile prints, e.g. "Shopify sessions"
  grains            TEXT NOT NULL CHECK (json_valid(grains) AND json_type(grains) = 'array' AND json_array_length(grains) > 0),
  direction         TEXT,                   -- higher_better | lower_better | neutral
  comparison_mode   TEXT NOT NULL,          -- drop_day | none
  treatment         TEXT,                   -- stated rules, e.g. COGS on cancelled units
  source_tables     TEXT NOT NULL CHECK (json_valid(source_tables) AND json_type(source_tables) = 'array'),
  effective_from    TEXT NOT NULL,          -- YYYY-MM-DD; the definition governs weeks ending on/after this
  effective_to      TEXT,                   -- exclusive; NULL = current
  change_note       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (metric_key, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Exactly one current version per metric. Redefinition = close the old row
-- (effective_to) and insert version + 1, so the system can tell its own
-- redefinitions apart from external breaks (§14).
CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_definitions_current
  ON metric_definitions (metric_key) WHERE effective_to IS NULL;

-- Computed values, for the continuity monitor's series and for staleness.
CREATE TABLE IF NOT EXISTS metric_snapshots (
  metric_key             TEXT NOT NULL,
  definition_version     INTEGER NOT NULL,
  grain                  TEXT NOT NULL,
  entity_id              TEXT NOT NULL DEFAULT '',
  period_start           TEXT NOT NULL,
  period_end             TEXT NOT NULL,
  value                  REAL,
  coverage               REAL CHECK (coverage IS NULL OR (coverage >= 0 AND coverage <= 1)),
  state                  TEXT NOT NULL,
  computed_at            TEXT NOT NULL,
  source_max_loaded_at   TEXT,
  PRIMARY KEY (metric_key, grain, entity_id, period_start, period_end),
  CHECK (period_end >= period_start)
);

-- §14. A flag carries the date of the suspected break so investigation has a window.
CREATE TABLE IF NOT EXISTS metric_continuity_flags (
  flag_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_key          TEXT NOT NULL,
  grain               TEXT NOT NULL DEFAULT 'week',
  entity_id           TEXT NOT NULL DEFAULT '',
  break_date          TEXT NOT NULL,
  detected_at         TEXT NOT NULL,
  signal              TEXT NOT NULL,          -- collection_change | definition_change | instrumentation | constancy | genuine_change
  evidence_json       TEXT NOT NULL CHECK (json_valid(evidence_json)),
  status              TEXT NOT NULL DEFAULT 'open',  -- open | explained | cleared
  definition_version  INTEGER,
  resolved_at         TEXT,
  resolution_note     TEXT,
  CHECK (resolved_at IS NULL OR resolved_at >= detected_at)
);

CREATE INDEX IF NOT EXISTS idx_metric_continuity_open
  ON metric_continuity_flags (status, metric_key, break_date);

-- Every fact load. A metric computed before its source's latest load is stale.
CREATE TABLE IF NOT EXISTS load_log (
  load_id           TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  target_table      TEXT NOT NULL,
  period_start      TEXT,
  period_end        TEXT,
  rows_written      INTEGER CHECK (rows_written IS NULL OR rows_written >= 0),
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL,          -- running | succeeded | failed
  error             TEXT,
  contract_version  TEXT,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_load_log_target ON load_log (target_table, status, finished_at);
