-- Return and exchange requests from Yanet (founder question 3).
--
-- Why this is not fact_refund or fact_exchange. Every row in the first export
-- "requested" or "approved". A refund row means money went back; an exchange row
-- means a replacement shipped. Neither has happened yet for these. Writing them
-- into those tables would state as settled what is still a request, and the rate
-- per SKU would count intentions as outcomes. When a request completes, it can
-- produce the matching fact_refund / fact_exchange row from here.
--
-- One row per requested item, because a request can name several: the export packs
-- them into newline-separated lists in one cell, and the per-item reason travels in
-- the same order.
--
-- No personal data. The export carries the customer's name, email, phone and
-- address; none of those columns are read, stored or logged.
CREATE TABLE IF NOT EXISTS fact_return_request (
  request_id            TEXT NOT NULL,           -- Yanet's own, e.g. #RET000001
  item_index            INTEGER NOT NULL CHECK (item_index >= 0),
  source                TEXT NOT NULL DEFAULT 'yanet',
  order_id              TEXT,                    -- numeric Shopify id, from the gid
  order_name            TEXT,                    -- e.g. #10009
  request_type          TEXT NOT NULL,           -- return | exchange (validated in code)
  status                TEXT,                    -- requested | approved | ... as exported
  product_status        TEXT,
  is_refunded           INTEGER CHECK (is_refunded IN (0, 1)),
  is_cancelled          INTEGER CHECK (is_cancelled IN (0, 1)),
  requested_at          TEXT,
  updated_at            TEXT,
  date                  TEXT,                    -- Cairo day of requested_at
  week_start            TEXT,
  order_date            TEXT,                    -- the order's own day, when matched
  product_title         TEXT,
  variant_title         TEXT,
  size                  TEXT,
  product_id            TEXT,
  variant_id            TEXT,
  match_method          TEXT,                    -- order_line | title_size | unmatched
  quantity              INTEGER CHECK (quantity IS NULL OR quantity >= 0),
  reason_code           TEXT,
  reason_text           TEXT,
  item_value            REAL CHECK (item_value IS NULL OR item_value >= 0),
  restocking_fee        REAL CHECK (restocking_fee IS NULL OR restocking_fee >= 0),
  return_shipping_fee   REAL CHECK (return_shipping_fee IS NULL OR return_shipping_fee >= 0),
  exchange_product_title TEXT,
  exchange_size         TEXT,
  exchange_value        REAL CHECK (exchange_value IS NULL OR exchange_value >= 0),
  currency              TEXT NOT NULL DEFAULT 'EGP',
  import_batch_id       TEXT,
  load_id               TEXT,
  PRIMARY KEY (request_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_fact_return_request_order ON fact_return_request (order_id);
CREATE INDEX IF NOT EXISTS idx_fact_return_request_week ON fact_return_request (week_start);
CREATE INDEX IF NOT EXISTS idx_fact_return_request_variant ON fact_return_request (variant_id);
