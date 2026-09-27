PRAGMA foreign_keys = ON;

-- Growth OS L0 — facts (GROWTH-OS-SESSION-1-SPEC.md §5).
--
-- No writer yet for any table here. Every row carries the load that wrote it
-- (load_id -> load_log) so staleness is computable. Excluded orders are kept with
-- exclusion_rule set: an exclusion must be able to report what it removed.

CREATE TABLE IF NOT EXISTS fact_order (
  order_id                           TEXT PRIMARY KEY,
  order_name                         TEXT,
  created_at                         TEXT NOT NULL,
  date                               TEXT NOT NULL,     -- Cairo calendar day of created_at
  week_start                         TEXT NOT NULL,     -- Sunday of that day's week
  drop_id                            TEXT,
  days_since_drop                    INTEGER CHECK (days_since_drop IS NULL OR days_since_drop >= 0),  -- from drop_date, launch day = 0
  customer_id                        TEXT,
  is_new_customer                    INTEGER CHECK (is_new_customer IN (0, 1)),
  sales_channel                      TEXT,              -- online_store | pos | draft | other (validated in code)
  location_id                        TEXT,
  currency                           TEXT NOT NULL DEFAULT 'EGP',
  subtotal                           REAL,
  discount_total                     REAL CHECK (discount_total IS NULL OR discount_total >= 0),
  shipping_charged                   REAL CHECK (shipping_charged IS NULL OR shipping_charged >= 0),
  tax                                REAL,
  total                              REAL,
  discount_codes                     TEXT CHECK (discount_codes IS NULL OR json_valid(discount_codes)),
  offer_id                           TEXT,
  gateway                            TEXT,
  is_cod                             INTEGER CHECK (is_cod IN (0, 1)),
  financial_status                   TEXT,
  fulfillment_status                 TEXT,
  first_fulfillment_created_at       TEXT,
  cancelled_at                       TEXT,
  cancel_reason                      TEXT,
  fulfillment_state_at_cancellation  TEXT,              -- pre_dispatch | post_dispatch | unknown
  refunded_amount                    REAL CHECK (refunded_amount IS NULL OR refunded_amount >= 0),
  delivery_status                    TEXT,
  delivered_at                       TEXT,
  attempt_count                      INTEGER CHECK (attempt_count IS NULL OR attempt_count >= 0),
  courier_id                         TEXT,
  ship_city                          TEXT,
  ship_governorate                   TEXT,
  ship_governorate_code              TEXT,
  landing_site                       TEXT,
  referring_site                     TEXT,
  order_referrer_source              TEXT,
  utm_source                         TEXT,
  utm_medium                         TEXT,
  utm_campaign                       TEXT,
  utm_content                        TEXT,
  utm_term                           TEXT,
  click_id                           TEXT,
  click_platform                     TEXT,
  attributed_ad_id                   TEXT,
  attribution_method                 TEXT,
  units_total                        INTEGER CHECK (units_total IS NULL OR units_total >= 0),
  exclusion_rule                     TEXT,              -- NULL = included; else the ORDER_EXCLUSION_RULES id
  source_updated_at                  TEXT,
  load_id                            TEXT,
  loaded_at                          TEXT
);

CREATE INDEX IF NOT EXISTS idx_fact_order_week ON fact_order (week_start, exclusion_rule);
CREATE INDEX IF NOT EXISTS idx_fact_order_date ON fact_order (date);
CREATE INDEX IF NOT EXISTS idx_fact_order_drop ON fact_order (drop_id, days_since_drop);
CREATE INDEX IF NOT EXISTS idx_fact_order_customer ON fact_order (customer_id);
CREATE INDEX IF NOT EXISTS idx_fact_order_ad ON fact_order (attributed_ad_id);

CREATE TABLE IF NOT EXISTS fact_order_line (
  order_id            TEXT NOT NULL,
  line_id             TEXT NOT NULL,
  variant_id          TEXT,
  product_id          TEXT,
  sku                 TEXT,
  quantity            INTEGER NOT NULL CHECK (quantity >= 0),
  unit_price          REAL CHECK (unit_price IS NULL OR unit_price >= 0),
  line_discount       REAL CHECK (line_discount IS NULL OR line_discount >= 0),
  unit_cogs_snapshot  REAL CHECK (unit_cogs_snapshot IS NULL OR unit_cogs_snapshot >= 0),
  bundle_flag         INTEGER CHECK (bundle_flag IN (0, 1)),
  bundle_id           TEXT,
  load_id             TEXT,
  PRIMARY KEY (order_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_fact_order_line_variant ON fact_order_line (variant_id);
CREATE INDEX IF NOT EXISTS idx_fact_order_line_product ON fact_order_line (product_id);

-- System 1 of 3: reversals (cancellations = RTO). Its own table because the cancel
-- week and the order week differ; weekly figures attribute on order_week.
CREATE TABLE IF NOT EXISTS fact_reversal (
  order_id                           TEXT PRIMARY KEY,
  cancelled_at                       TEXT NOT NULL,
  cancel_week                        TEXT NOT NULL,
  order_created_at                   TEXT NOT NULL,
  order_week                         TEXT NOT NULL,
  drop_id                            TEXT,
  days_since_drop                    INTEGER CHECK (days_since_drop IS NULL OR days_since_drop >= 0),
  currency                           TEXT NOT NULL DEFAULT 'EGP',
  value                              REAL CHECK (value IS NULL OR value >= 0),
  units                              INTEGER CHECK (units IS NULL OR units >= 0),
  pre_or_post_dispatch               TEXT,              -- derived from fulfilment state at cancellation
  cancel_reason                      TEXT,              -- platform reason, as given
  courier_reason                     TEXT,
  reason_code                        TEXT,              -- dim_reason taxonomy, NULL = unclassified
  reason_source                      TEXT,
  governorate                        TEXT,
  is_cod                             INTEGER CHECK (is_cod IN (0, 1)),
  attributed_ad_id                   TEXT,
  sales_channel                      TEXT,
  location_id                        TEXT,
  load_id                            TEXT,
  CHECK (cancelled_at >= order_created_at)
);

CREATE INDEX IF NOT EXISTS idx_fact_reversal_order_week ON fact_reversal (order_week);
CREATE INDEX IF NOT EXISTS idx_fact_reversal_cancel_week ON fact_reversal (cancel_week);

-- Per-SKU and per-size reversals come from the cancelled order's line items, not
-- from courier outcomes, which miss cancellations that never shipped.
CREATE TABLE IF NOT EXISTS fact_reversal_line (
  order_id    TEXT NOT NULL,
  line_id     TEXT NOT NULL,
  variant_id  TEXT,
  product_id  TEXT,
  size        TEXT,
  quantity    INTEGER NOT NULL CHECK (quantity >= 0),
  value       REAL CHECK (value IS NULL OR value >= 0),
  load_id     TEXT,
  PRIMARY KEY (order_id, line_id)
);

-- System 2 of 3: genuine refunds (Shopify Refund objects). Never merged with
-- fact_reversal at any layer.
CREATE TABLE IF NOT EXISTS fact_refund (
  refund_id          TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  date               TEXT NOT NULL,
  week_start         TEXT NOT NULL,
  order_week         TEXT,
  currency           TEXT NOT NULL DEFAULT 'EGP',
  amount             REAL CHECK (amount IS NULL OR amount >= 0),
  shipping_refunded  REAL CHECK (shipping_refunded IS NULL OR shipping_refunded >= 0),
  reason_code        TEXT,
  reason_text        TEXT,
  reason_source      TEXT,                          -- shopify | yanet
  external_ref       TEXT,                          -- e.g. the Yanet request id
  import_batch_id    TEXT,
  load_id            TEXT
);

CREATE INDEX IF NOT EXISTS idx_fact_refund_order ON fact_refund (order_id);
CREATE INDEX IF NOT EXISTS idx_fact_refund_week ON fact_refund (week_start);

CREATE TABLE IF NOT EXISTS fact_refund_line (
  refund_id     TEXT NOT NULL,
  line_id       TEXT NOT NULL,
  variant_id    TEXT,
  product_id    TEXT,
  size          TEXT,
  quantity      INTEGER NOT NULL CHECK (quantity >= 0),
  amount        REAL CHECK (amount IS NULL OR amount >= 0),
  restock_type  TEXT,
  PRIMARY KEY (refund_id, line_id)
);

-- System 3 of 3: exchanges. One row per exchanged item. Yanet exports carry the
-- reason; the raw export is staged in import_row and mapped here.
CREATE TABLE IF NOT EXISTS fact_exchange (
  exchange_id             TEXT PRIMARY KEY,
  order_id                TEXT,
  source                  TEXT NOT NULL,            -- yanet | shopify | manual
  external_ref            TEXT,
  requested_at            TEXT,
  completed_at            TEXT,
  status                  TEXT,
  reason_code             TEXT,
  reason_text             TEXT,
  original_variant_id     TEXT,
  original_product_id     TEXT,
  original_size           TEXT,
  replacement_variant_id  TEXT,
  replacement_product_id  TEXT,
  replacement_size        TEXT,
  quantity                INTEGER CHECK (quantity IS NULL OR quantity >= 0),
  currency                TEXT NOT NULL DEFAULT 'EGP',
  price_difference        REAL,
  shipping_cost           REAL CHECK (shipping_cost IS NULL OR shipping_cost >= 0),
  new_order_id            TEXT,
  import_batch_id         TEXT,
  load_id                 TEXT,
  CHECK (completed_at IS NULL OR requested_at IS NULL OR completed_at >= requested_at)
);

CREATE INDEX IF NOT EXISTS idx_fact_exchange_order ON fact_exchange (order_id);
CREATE INDEX IF NOT EXISTS idx_fact_exchange_requested ON fact_exchange (requested_at);

CREATE TABLE IF NOT EXISTS fact_ad_daily (
  date                 TEXT NOT NULL,
  platform             TEXT NOT NULL,
  ad_id                TEXT NOT NULL,
  adset_id             TEXT,
  campaign_id          TEXT,
  currency             TEXT NOT NULL DEFAULT 'EGP',
  spend                REAL CHECK (spend IS NULL OR spend >= 0),
  impressions          INTEGER CHECK (impressions IS NULL OR impressions >= 0),
  reach                INTEGER CHECK (reach IS NULL OR reach >= 0),
  frequency            REAL,
  clicks_all           INTEGER CHECK (clicks_all IS NULL OR clicks_all >= 0),
  clicks_outbound      INTEGER CHECK (clicks_outbound IS NULL OR clicks_outbound >= 0),
  video_plays_3s       INTEGER CHECK (video_plays_3s IS NULL OR video_plays_3s >= 0),
  thruplays            INTEGER CHECK (thruplays IS NULL OR thruplays >= 0),
  video_p25            INTEGER,
  video_p50            INTEGER,
  video_p75            INTEGER,
  video_p100           INTEGER,
  landing_page_views   INTEGER CHECK (landing_page_views IS NULL OR landing_page_views >= 0),
  platform_atc         INTEGER,
  platform_ic          INTEGER,
  platform_purchases   INTEGER,
  platform_revenue     REAL,
  attribution_setting  TEXT,
  status               TEXT,
  days_active          INTEGER CHECK (days_active IS NULL OR days_active >= 0),
  load_id              TEXT,
  PRIMARY KEY (date, platform, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_fact_ad_daily_ad ON fact_ad_daily (platform, ad_id, date);

-- Reach does not sum across ads, so adset reach is its own grain.
CREATE TABLE IF NOT EXISTS fact_adset_daily (
  date         TEXT NOT NULL,
  platform     TEXT NOT NULL,
  adset_id     TEXT NOT NULL,
  campaign_id  TEXT,
  currency     TEXT NOT NULL DEFAULT 'EGP',
  spend        REAL CHECK (spend IS NULL OR spend >= 0),
  impressions  INTEGER CHECK (impressions IS NULL OR impressions >= 0),
  reach        INTEGER CHECK (reach IS NULL OR reach >= 0),
  frequency    REAL,
  load_id      TEXT,
  PRIMARY KEY (date, platform, adset_id)
);

-- GA4 in breakdown shape: one row per (date, named breakdown, up to three dimension
-- values). breakdown_id 'total' holds the unsegmented day, because segments summed
-- under GA4 thresholding never equal the total. is_other_row marks GA4's
-- cardinality-truncation "(other)" row so it surfaces instead of distorting a segment.
CREATE TABLE IF NOT EXISTS fact_ga4_daily (
  date                   TEXT NOT NULL,
  breakdown_id           TEXT NOT NULL,
  dim1_value             TEXT NOT NULL DEFAULT '',
  dim2_value             TEXT NOT NULL DEFAULT '',
  dim3_value             TEXT NOT NULL DEFAULT '',
  is_other_row           INTEGER NOT NULL DEFAULT 0 CHECK (is_other_row IN (0, 1)),
  sessions               INTEGER CHECK (sessions IS NULL OR sessions >= 0),
  engaged_sessions       INTEGER CHECK (engaged_sessions IS NULL OR engaged_sessions >= 0),
  engagement_time_sec    REAL CHECK (engagement_time_sec IS NULL OR engagement_time_sec >= 0),
  view_item              INTEGER CHECK (view_item IS NULL OR view_item >= 0),
  add_to_cart            INTEGER CHECK (add_to_cart IS NULL OR add_to_cart >= 0),
  begin_checkout         INTEGER CHECK (begin_checkout IS NULL OR begin_checkout >= 0),
  add_payment_info       INTEGER CHECK (add_payment_info IS NULL OR add_payment_info >= 0),
  purchase               INTEGER CHECK (purchase IS NULL OR purchase >= 0),
  load_id                TEXT,
  PRIMARY KEY (date, breakdown_id, dim1_value, dim2_value, dim3_value)
);

CREATE INDEX IF NOT EXISTS idx_fact_ga4_daily_breakdown ON fact_ga4_daily (breakdown_id, date);

-- GA4 item-scoped metrics (PDP views, item add-to-cart) cannot share a row with
-- session-scoped metrics, so they have their own grain.
CREATE TABLE IF NOT EXISTS fact_ga4_item_daily (
  date                  TEXT NOT NULL,
  item_id               TEXT NOT NULL,          -- as sent in the GA4 ecommerce payload
  variant_id            TEXT,
  product_id            TEXT,
  items_viewed          INTEGER CHECK (items_viewed IS NULL OR items_viewed >= 0),
  items_added_to_cart   INTEGER CHECK (items_added_to_cart IS NULL OR items_added_to_cart >= 0),
  items_checked_out     INTEGER CHECK (items_checked_out IS NULL OR items_checked_out >= 0),
  items_purchased       INTEGER CHECK (items_purchased IS NULL OR items_purchased >= 0),
  load_id               TEXT,
  PRIMARY KEY (date, item_id)
);

CREATE INDEX IF NOT EXISTS idx_fact_ga4_item_daily_product ON fact_ga4_item_daily (product_id, date);

-- The Shopify session basis, same breakdown shape, kept separate and labelled.
-- One session source per metric, never mixed.
CREATE TABLE IF NOT EXISTS fact_session_daily (
  date                        TEXT NOT NULL,
  breakdown_id                TEXT NOT NULL,
  dim1_value                  TEXT NOT NULL DEFAULT '',
  dim2_value                  TEXT NOT NULL DEFAULT '',
  dim3_value                  TEXT NOT NULL DEFAULT '',
  is_other_row                INTEGER NOT NULL DEFAULT 0 CHECK (is_other_row IN (0, 1)),
  sessions                    INTEGER CHECK (sessions IS NULL OR sessions >= 0),
  sessions_with_cart_add      INTEGER CHECK (sessions_with_cart_add IS NULL OR sessions_with_cart_add >= 0),
  sessions_reached_checkout   INTEGER CHECK (sessions_reached_checkout IS NULL OR sessions_reached_checkout >= 0),
  sessions_converted          INTEGER CHECK (sessions_converted IS NULL OR sessions_converted >= 0),
  load_id                     TEXT,
  PRIMARY KEY (date, breakdown_id, dim1_value, dim2_value, dim3_value)
);

-- Daily grain, immutable once written. Keyed by location so the own store and
-- partner stores hold stock without a rebuild. Writers insert with
-- INSERT ... SELECT ... WHERE NOT EXISTS; a duplicate, an UPDATE or a DELETE aborts.
CREATE TABLE IF NOT EXISTS fact_inventory_daily (
  date          TEXT NOT NULL,
  variant_id    TEXT NOT NULL,
  location_id   TEXT NOT NULL,
  qty_on_hand   INTEGER,
  is_oos        INTEGER CHECK (is_oos IN (0, 1)),
  load_id       TEXT,
  loaded_at     TEXT,
  PRIMARY KEY (date, variant_id, location_id)
);

CREATE TRIGGER IF NOT EXISTS trg_fact_inventory_daily_no_duplicate
BEFORE INSERT ON fact_inventory_daily
WHEN EXISTS (
  SELECT 1 FROM fact_inventory_daily
  WHERE date = NEW.date AND variant_id = NEW.variant_id AND location_id = NEW.location_id
)
BEGIN
  SELECT RAISE(ABORT, 'fact_inventory_daily is immutable: row already written');
END;

CREATE TRIGGER IF NOT EXISTS trg_fact_inventory_daily_no_update
BEFORE UPDATE ON fact_inventory_daily
BEGIN
  SELECT RAISE(ABORT, 'fact_inventory_daily is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_fact_inventory_daily_no_delete
BEFORE DELETE ON fact_inventory_daily
BEGIN
  SELECT RAISE(ABORT, 'fact_inventory_daily is immutable');
END;

-- Partner-store weekly reports (GenZ, Go Native). Their period need not be our
-- Sunday week, so the report's own period is kept. sku is as reported; variant_id
-- is filled when the SKU maps.
CREATE TABLE IF NOT EXISTS fact_location_sku_weekly (
  location_id       TEXT NOT NULL,
  period_start      TEXT NOT NULL,
  period_end        TEXT NOT NULL,
  sku               TEXT NOT NULL,
  variant_id        TEXT,
  product_id        TEXT,
  units_sold        INTEGER CHECK (units_sold IS NULL OR units_sold >= 0),
  stock_on_hand     INTEGER,
  stock_received    INTEGER,
  currency          TEXT NOT NULL DEFAULT 'EGP',
  revenue_reported  REAL,
  import_batch_id   TEXT,
  load_id           TEXT,
  PRIMARY KEY (location_id, period_start, period_end, sku),
  CHECK (period_end >= period_start)
);
