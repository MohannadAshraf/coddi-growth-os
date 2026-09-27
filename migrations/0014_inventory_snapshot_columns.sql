PRAGMA foreign_keys = ON;

-- Daily inventory snapshot writer (first Growth OS fact writer).
--
-- Live Shopify shows on_hand and available diverging sharply — held stock on
-- draft products reads on_hand > 0 with available = 0. Sell-through against what
-- was committed needs on_hand; out-of-stock on the storefront needs available.
-- Both are kept. Additive only.
ALTER TABLE fact_inventory_daily ADD COLUMN qty_available INTEGER;

ALTER TABLE dim_variant ADD COLUMN inventory_policy TEXT;       -- DENY | CONTINUE (validated in code)
ALTER TABLE dim_variant ADD COLUMN inventory_tracked INTEGER CHECK (inventory_tracked IN (0, 1));

ALTER TABLE dim_product ADD COLUMN shopify_created_at TEXT;
