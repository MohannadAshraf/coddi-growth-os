-- Which stock locations fulfil the Egyptian online store.
--
-- The sell-through denominator is stock held before a drop launches. Shopify
-- Counting all of them would credit the drop with stock that can never ship to an
-- Egyptian customer. This flag is data, not code, so the founder can correct it
-- without a deploy.
--
-- NULL means unclassified: its stock is left out of the commitment and lowers the
-- metric's coverage, so a new location shows up as partial rather than silently
-- shrinking the denominator. dim_location rows are written INSERT OR IGNORE, so
-- the nightly snapshot never overwrites these.
ALTER TABLE dim_location ADD COLUMN fulfils_online INTEGER CHECK (fulfils_online IN (0, 1));

UPDATE dim_location SET fulfils_online = 1 WHERE location_id = 'shopify:10000000001';  -- CODDI EGYPT
UPDATE dim_location SET fulfils_online = 0 WHERE location_id IN (
  'shopify:111876800803',  -- CODDI KSA: another country's stock
  'shopify:100000000002',  -- Chainz (app uninstalled)
  'shopify:100000000003'   -- District 5
);
