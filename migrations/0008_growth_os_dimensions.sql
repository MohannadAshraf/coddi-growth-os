PRAGMA foreign_keys = ON;

-- Growth OS L0 — dimensions (GROWTH-OS-SESSION-1-SPEC.md §5).
--
-- Shape is the deliverable: most of these tables have no writer yet. A metric that
-- reads an empty table resolves to state "missing", which is the designed answer.
--
-- CHECK constraints guard invariants only. Enumerations that can grow (status,
-- kind, channel, platform, format) are validated in code: changing a CHECK in
-- SQLite is a table rebuild, and v3 must land as additions, never rebuilds.
-- Money columns carry a currency so an FX / real-terms basis is additive.

-- Calendar. Payday, holiday and Ramadan columns stay NULL until a writer states
-- them — NULL means "not known", never "no".
CREATE TABLE IF NOT EXISTS dim_date (
  date              TEXT PRIMARY KEY,         -- YYYY-MM-DD, Africa/Cairo calendar day
  week_start        TEXT NOT NULL,            -- Sunday of the reporting week
  iso_week          TEXT NOT NULL,            -- YYYY-Www
  month             TEXT NOT NULL,            -- YYYY-MM
  day_of_week       INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0 = Sunday
  is_payday_window  INTEGER CHECK (is_payday_window IN (0, 1)),
  is_holiday        INTEGER CHECK (is_holiday IN (0, 1)),
  holiday_name      TEXT,
  ramadan_flag      INTEGER CHECK (ramadan_flag IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_dim_date_week ON dim_date (week_start);

WITH RECURSIVE days(d) AS (
  SELECT '2025-01-01'
  UNION ALL
  SELECT date(d, '+1 day') FROM days WHERE d < '2027-12-31'
)
INSERT OR IGNORE INTO dim_date (date, week_start, iso_week, month, day_of_week)
SELECT
  d,
  date(d, '-' || strftime('%w', d) || ' days'),
  -- ISO week-year and number: the Thursday of the ISO week decides the year.
  strftime('%Y', date(d, '-' || ((CAST(strftime('%w', d) AS INTEGER) + 6) % 7) || ' days', '+3 days'))
    || '-W'
    || printf('%02d', (CAST(strftime('%j', date(d, '-' || ((CAST(strftime('%w', d) AS INTEGER) + 6) % 7) || ' days', '+3 days')) AS INTEGER) - 1) / 7 + 1),
  strftime('%Y-%m', d),
  CAST(strftime('%w', d) AS INTEGER)
FROM days;

-- dim_drop exists (0006, 0007). v2 "name" is the existing `label`.
ALTER TABLE dim_drop ADD COLUMN product_count INTEGER CHECK (product_count IS NULL OR product_count >= 0);
ALTER TABLE dim_drop ADD COLUMN units_committed INTEGER CHECK (units_committed IS NULL OR units_committed >= 0);
ALTER TABLE dim_drop ADD COLUMN gap_days_from_prior INTEGER CHECK (gap_days_from_prior IS NULL OR gap_days_from_prior >= 0);
-- Planned drop-window ad budget: the denominator of spend_pace. NULL = not planned.
ALTER TABLE dim_drop ADD COLUMN planned_ad_budget REAL CHECK (planned_ad_budget IS NULL OR planned_ad_budget >= 0);

-- Supply fields (v3): lead time, MOQ, supplier. Variants may override.
CREATE TABLE IF NOT EXISTS dim_product (
  product_id         TEXT PRIMARY KEY,
  handle             TEXT,
  title              TEXT,
  category           TEXT,
  product_type       TEXT,
  drop_id            TEXT,
  launched_at        TEXT,
  published_at       TEXT,
  status             TEXT,
  seasonality        TEXT,                    -- warm | cold | all_season (validated in code)
  price_tier         TEXT,
  lead_time_days     INTEGER CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  moq_units          INTEGER CHECK (moq_units IS NULL OR moq_units >= 0),
  supplier           TEXT,
  source_updated_at  TEXT,
  loaded_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_dim_product_drop ON dim_product (drop_id);

-- Size is first-class. inventory_qty is a convenience snapshot; the daily truth is
-- fact_inventory_daily.
CREATE TABLE IF NOT EXISTS dim_variant (
  variant_id          TEXT PRIMARY KEY,
  product_id          TEXT NOT NULL,
  sku                 TEXT,
  size                TEXT,
  color               TEXT,
  price               REAL CHECK (price IS NULL OR price >= 0),
  currency            TEXT NOT NULL DEFAULT 'EGP',
  unit_cogs_snapshot  REAL CHECK (unit_cogs_snapshot IS NULL OR unit_cogs_snapshot >= 0),
  inventory_qty       INTEGER,
  lead_time_days      INTEGER CHECK (lead_time_days IS NULL OR lead_time_days >= 0),  -- NULL = inherit product
  moq_units           INTEGER CHECK (moq_units IS NULL OR moq_units >= 0),            -- NULL = inherit product
  source_updated_at   TEXT,
  loaded_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_dim_variant_product ON dim_variant (product_id);
CREATE INDEX IF NOT EXISTS idx_dim_variant_sku ON dim_variant (sku);

-- Creative concept: the unit "what do we shoot next" rolls up to, and where
-- production cost lives (v3).
CREATE TABLE IF NOT EXISTS dim_concept (
  concept_id           TEXT PRIMARY KEY,
  name                 TEXT,
  angle                TEXT,
  hook_type            TEXT,
  creator              TEXT,
  offer_id             TEXT,
  promoted_product_id  TEXT,
  production_cost      REAL CHECK (production_cost IS NULL OR production_cost >= 0),
  currency             TEXT NOT NULL DEFAULT 'EGP',
  produced_at          TEXT,
  notes                TEXT,
  created_at           TEXT,
  updated_at           TEXT
);

-- Keyed by platform too: ad ids are only unique within a platform.
CREATE TABLE IF NOT EXISTS dim_ad (
  platform             TEXT NOT NULL,
  ad_id                TEXT NOT NULL,
  account_id           TEXT,
  adset_id             TEXT,
  adset_name           TEXT,
  campaign_id          TEXT,
  campaign_name        TEXT,
  ad_name              TEXT,
  creative_id          TEXT,
  format               TEXT,
  created_time         TEXT,
  first_seen           TEXT,
  last_seen            TEXT,
  effective_status     TEXT,
  status_checked_at    TEXT,
  -- Tagging layer. NULL = untagged, which is reported as tagging coverage.
  promoted_product_id  TEXT,
  angle                TEXT,
  hook_type            TEXT,
  creator              TEXT,
  offer_id             TEXT,
  concept_id           TEXT,
  production_cost      REAL CHECK (production_cost IS NULL OR production_cost >= 0),  -- per-ad override of the concept cost
  currency             TEXT NOT NULL DEFAULT 'EGP',
  tagged_at            TEXT,
  tagged_by            TEXT,
  loaded_at            TEXT,
  PRIMARY KEY (platform, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_dim_ad_adset ON dim_ad (platform, adset_id);
CREATE INDEX IF NOT EXISTS idx_dim_ad_campaign ON dim_ad (platform, campaign_id);
CREATE INDEX IF NOT EXISTS idx_dim_ad_concept ON dim_ad (concept_id);

-- The source of every contamination flag. A structural window here makes the flag
-- self-detecting instead of hand-entered.
CREATE TABLE IF NOT EXISTS dim_offer (
  offer_id              TEXT PRIMARY KEY,
  type                  TEXT,                 -- none | percent | bundle | free_shipping | code | automatic
  mechanic              TEXT,
  scope                 TEXT,                 -- sitewide | collection | product
  scope_ref             TEXT,
  depth                 REAL CHECK (depth IS NULL OR depth >= 0),
  depth_unit            TEXT,                 -- percent | EGP
  start_at              TEXT,
  end_at                TEXT,
  is_structural_window  INTEGER NOT NULL DEFAULT 0 CHECK (is_structural_window IN (0, 1)),
  source                TEXT,
  source_ref            TEXT,
  notes                 TEXT,
  created_at            TEXT,
  updated_at            TEXT,
  CHECK (end_at IS NULL OR start_at IS NULL OR end_at >= start_at)
);

CREATE INDEX IF NOT EXISTS idx_dim_offer_window ON dim_offer (start_at, end_at);

-- No PII: no name, phone, email or street address.
CREATE TABLE IF NOT EXISTS dim_customer (
  customer_id              TEXT PRIMARY KEY,
  first_order_at           TEXT,
  acquisition_drop_id      TEXT,
  acquisition_source       TEXT,
  acquisition_offer_id     TEXT,
  acquisition_location_id  TEXT,
  governorate              TEXT,
  orders_lifetime          INTEGER CHECK (orders_lifetime IS NULL OR orders_lifetime >= 0),
  revenue_lifetime         REAL,
  discount_dependence      REAL CHECK (discount_dependence IS NULL OR (discount_dependence >= 0 AND discount_dependence <= 1)),
  rto_history_count        INTEGER CHECK (rto_history_count IS NULL OR rto_history_count >= 0),
  refund_history_count     INTEGER CHECK (refund_history_count IS NULL OR refund_history_count >= 0),
  exchange_history_count   INTEGER CHECK (exchange_history_count IS NULL OR exchange_history_count >= 0),
  updated_at               TEXT
);

CREATE INDEX IF NOT EXISTS idx_dim_customer_acq_drop ON dim_customer (acquisition_drop_id);
CREATE INDEX IF NOT EXISTS idx_dim_customer_acq_offer ON dim_customer (acquisition_offer_id);

CREATE TABLE IF NOT EXISTS dim_geo (
  geo_id            TEXT PRIMARY KEY,
  governorate       TEXT NOT NULL,
  governorate_code  TEXT,
  city              TEXT NOT NULL DEFAULT '',
  courier_zone      TEXT,
  UNIQUE (governorate_code, city)
);

-- Minimal on purpose: v3 cash (remittances, receivables) keys on courier_id.
CREATE TABLE IF NOT EXISTS dim_courier (
  courier_id  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  notes       TEXT
);

-- Where a sale happened. Online, own store on Shopify POS, and partner stores whose
-- weekly reports arrive as imports (fact_location_sku_weekly).
CREATE TABLE IF NOT EXISTS dim_location (
  location_id          TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL,         -- online | own_store | partner_store (validated in code)
  channel              TEXT NOT NULL,         -- shopify_online | shopify_pos | partner_report
  shopify_location_id  TEXT,
  partner_name         TEXT,
  city                 TEXT,
  governorate          TEXT,
  opened_at            TEXT,
  closed_at            TEXT,
  notes                TEXT,
  CHECK (closed_at IS NULL OR opened_at IS NULL OR closed_at >= opened_at)
);

-- Named funnel breakdowns (§7). Multi-dimension combinations are registered here by
-- name — device x source/medium is the most useful funnel view in the system — so a
-- writer fetches exactly these and a reader asks for them by name.
CREATE TABLE IF NOT EXISTS dim_breakdown (
  breakdown_id  TEXT PRIMARY KEY,
  source        TEXT NOT NULL,                -- ga4 | shopify_sessions
  dims          TEXT NOT NULL CHECK (json_valid(dims) AND json_type(dims) = 'array' AND json_array_length(dims) BETWEEN 0 AND 3),
  label         TEXT NOT NULL,
  purpose       TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- Reason taxonomy with owner routing (§11). applies_to is a JSON list, not a
-- two-way flag: RTO, refunds and exchanges are three systems.
CREATE TABLE IF NOT EXISTS dim_reason (
  reason_code  TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  applies_to   TEXT NOT NULL CHECK (json_valid(applies_to) AND json_type(applies_to) = 'array'),
  owner        TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
