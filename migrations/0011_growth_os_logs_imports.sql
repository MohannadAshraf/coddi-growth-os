PRAGMA foreign_keys = ON;

-- Growth OS L0 — memory (§13, §11, §12) and imports.
--
-- The CHECKs here are the spec's write-time rules, not enumerations: a decision
-- without evidence, an experiment without MDE or runtime, a forecast written after
-- its drop, an intervention called effective with no measured cohort — each is
-- rejected by the database, whatever code path writes it.

CREATE TABLE IF NOT EXISTS decision_log (
  decision_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  decided_on       TEXT NOT NULL,
  area             TEXT NOT NULL,
  context          TEXT,
  -- The numbers it rested on, with their basis: a non-empty JSON array of metric
  -- envelopes. Code validates each item's shape; the database refuses none at all.
  evidence_json    TEXT NOT NULL CHECK (
    json_valid(evidence_json)
    AND json_type(evidence_json) = 'array'
    AND json_array_length(evidence_json) > 0
  ),
  decision         TEXT NOT NULL,
  reason           TEXT NOT NULL,
  expected_result  TEXT,
  review_date      TEXT,
  actual_result    TEXT,
  lesson           TEXT,
  created_at       TEXT NOT NULL,
  created_by       TEXT,
  CHECK (review_date IS NULL OR review_date >= decided_on)
);

CREATE INDEX IF NOT EXISTS idx_decision_log_review ON decision_log (review_date);

CREATE TABLE IF NOT EXISTS experiment_log (
  experiment_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hypothesis             TEXT NOT NULL,
  area                   TEXT NOT NULL,
  control                TEXT NOT NULL,
  variant                TEXT NOT NULL,
  primary_metric         TEXT NOT NULL,
  mde                    REAL NOT NULL CHECK (mde > 0),                           -- minimum detectable effect
  baseline_value         REAL,
  volume_basis_json      TEXT CHECK (volume_basis_json IS NULL OR json_valid(volume_basis_json)),
  planned_runtime_days   INTEGER NOT NULL CHECK (planned_runtime_days > 0),       -- computed from MDE and current volume
  runtime_method         TEXT NOT NULL,
  started_on             TEXT,
  ended_on               TEXT,
  result_status          TEXT,          -- win | loss | flat | inconclusive
  result                 TEXT,
  decision               TEXT,
  created_at             TEXT NOT NULL,
  CHECK (ended_on IS NULL OR (started_on IS NOT NULL AND ended_on >= started_on)),
  -- Ending before the planned runtime records as inconclusive, never as a result.
  CHECK (
    ended_on IS NULL
    OR julianday(ended_on) - julianday(started_on) >= planned_runtime_days
    OR result_status = 'inconclusive'
  )
);

CREATE TABLE IF NOT EXISTS forecast_log (
  forecast_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  drop_id           TEXT NOT NULL,
  drop_date         TEXT NOT NULL,
  produced_at       TEXT NOT NULL,          -- instant, ISO-8601
  produced_on       TEXT NOT NULL,          -- Africa/Cairo calendar day of produced_at
  metric_key        TEXT NOT NULL,
  horizon_drop_day  INTEGER NOT NULL CHECK (horizon_drop_day >= 0),
  forecast_value    REAL NOT NULL,
  forecast_low      REAL,
  forecast_high     REAL,
  method            TEXT NOT NULL,
  inputs_json       TEXT CHECK (inputs_json IS NULL OR json_valid(inputs_json)),
  actual_value      REAL,
  scored_at         TEXT,
  abs_pct_error     REAL,
  -- A forecast cannot be retroactive.
  CHECK (produced_on < drop_date),
  CHECK (forecast_low IS NULL OR forecast_high IS NULL OR forecast_low <= forecast_high)
);

CREATE INDEX IF NOT EXISTS idx_forecast_log_drop ON forecast_log (drop_id, metric_key);

-- Scoring fills actual_value / scored_at / abs_pct_error. The forecast itself is
-- frozen once written.
CREATE TRIGGER IF NOT EXISTS trg_forecast_log_frozen
BEFORE UPDATE OF drop_id, drop_date, produced_at, produced_on, metric_key, horizon_drop_day,
                 forecast_value, forecast_low, forecast_high, method, inputs_json
ON forecast_log
BEGIN
  SELECT RAISE(ABORT, 'forecast_log: a forecast is frozen once written');
END;

CREATE TABLE IF NOT EXISTS intervention_log (
  intervention_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT NOT NULL,
  area                    TEXT NOT NULL DEFAULT 'rto',
  description             TEXT,
  started_on              TEXT NOT NULL,
  ended_on                TEXT,
  cohort_definition_json  TEXT CHECK (cohort_definition_json IS NULL OR json_valid(cohort_definition_json)),
  cohort_size             INTEGER CHECK (cohort_size IS NULL OR cohort_size >= 0),
  metric_key              TEXT,
  before_value            REAL,
  before_window_json      TEXT CHECK (before_window_json IS NULL OR json_valid(before_window_json)),
  after_value             REAL,
  after_window_json       TEXT CHECK (after_window_json IS NULL OR json_valid(after_window_json)),
  measurement_status      TEXT NOT NULL DEFAULT 'unmeasured',
  effect_summary          TEXT,
  created_at              TEXT NOT NULL,
  CHECK (ended_on IS NULL OR ended_on >= started_on),
  -- No measured cohort = unmeasured, never effective.
  CHECK (
    measurement_status = 'unmeasured'
    OR (cohort_definition_json IS NOT NULL AND metric_key IS NOT NULL
        AND before_value IS NOT NULL AND after_value IS NOT NULL)
  )
);

-- File imports (Yanet returns and exchanges, partner-store weekly reports). Rows are
-- staged raw, as JSON, so an export's column layout never needs a migration; a
-- mapper per source moves them into facts and records where each row went.
CREATE TABLE IF NOT EXISTS import_batch (
  batch_id      TEXT PRIMARY KEY,
  source        TEXT NOT NULL,              -- yanet_returns | yanet_exchanges | partner_report ...
  location_id   TEXT,
  period_start  TEXT,
  period_end    TEXT,
  file_name     TEXT,
  file_sha256   TEXT,
  row_count     INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  status        TEXT NOT NULL,              -- staged | mapped | failed
  imported_at   TEXT NOT NULL,
  imported_by   TEXT,
  notes         TEXT,
  error         TEXT,
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);

-- Same file twice is the same batch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_batch_file
  ON import_batch (source, file_sha256) WHERE file_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS import_row (
  batch_id      TEXT NOT NULL,
  row_num       INTEGER NOT NULL CHECK (row_num >= 1),
  raw_json      TEXT NOT NULL CHECK (json_valid(raw_json)),
  mapped_table  TEXT,
  mapped_key    TEXT,
  map_status    TEXT NOT NULL DEFAULT 'pending',   -- pending | mapped | rejected
  map_error     TEXT,
  PRIMARY KEY (batch_id, row_num)
);
