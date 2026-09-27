PRAGMA foreign_keys = ON;

-- P1.2 drop dimension.
--
-- Revenue is drop-driven, not calendar-driven: each drop spikes then decays over
-- 3-4 weeks toward a floor. Week-over-week and trailing-4-week comparisons
-- therefore produce a false "sales dropped, investigate conversion" alarm every
-- post-drop week. Comparisons must normalise on days_since_drop.
--
-- drop_date is the actual launch day. drop_week_start is the Sunday of the week
-- containing it, and is what days_since_drop is measured from, so W0 = 0,
-- W+1 = 7, W+2 = 14 and so on. The suppression window [7, 28] is W+1..W+4.
CREATE TABLE IF NOT EXISTS dim_drop (
  drop_id          TEXT PRIMARY KEY,
  drop_date        TEXT NOT NULL,          -- YYYY-MM-DD, the launch day
  drop_week_start  TEXT NOT NULL,          -- Sunday of the week containing drop_date
  season           TEXT NOT NULL DEFAULT '',
  label            TEXT NOT NULL DEFAULT '',
  -- Observed, not modelled. Seeded from the pipeline's own weekly order counts
  -- (ANALYST-HANDOFF.md §3.12), never from the knowledge-base curve, which
  -- disagrees with the pipeline on 5 of 5 weeks for Jul 26.
  w0_orders        INTEGER,
  floor_orders     INTEGER,
  orders_source    TEXT NOT NULL DEFAULT 'pipeline',
  notes            TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dim_drop_date
  ON dim_drop (drop_date DESC);

CREATE INDEX IF NOT EXISTS idx_dim_drop_week
  ON dim_drop (drop_week_start DESC);
