-- 0029 (2026-09-22): un-multiply the Meta action counts.
--
-- Meta reports one event under several aliases in the same `actions` list: a purchase
-- arrives as `omni_purchase`, `purchase` AND `offsite_conversion.fb_pixel_purchase`,
-- a landing page view as `landing_page_view` and `omni_landing_page_view`. The loader
-- summed every alias it recognised, so each event was counted once per alias, from the
-- first Meta load (2026-04-02) until the extractor was fixed on 2026-09-22.
--
--   platform_atc        3,137 non-zero rows, 3,137 divisible by 3  -> factor 3
--   platform_ic         2,426 non-zero rows, 2,426 divisible by 3  -> factor 3
-- platform_revenue comes from the same three purchase aliases as platform_purchases.
--
-- What it was doing to the numbers, on week 2026-09-13:
--
-- Only rows written by the old extractor are touched. The fix deployed on
-- already holds one count per event. Without this guard the order would matter: a
-- nightly Meta load landing before the migration would have its correct rows
-- divided a second time. The last load before the fix was 2026-09-21T17:13Z.
--
-- Rollback: multiply the same five columns back by the same factors, with the same
-- WHERE. Any later Meta reload overwrites these rows outright and needs no rollback.
UPDATE fact_ad_daily SET landing_page_views = landing_page_views / 2
  WHERE landing_page_views IS NOT NULL AND (load_id IS NULL OR substr(load_id, instr(load_id, '@') + 1) < '2026-09-22');
UPDATE fact_ad_daily SET platform_atc = platform_atc / 3
  WHERE platform_atc IS NOT NULL AND (load_id IS NULL OR substr(load_id, instr(load_id, '@') + 1) < '2026-09-22');
UPDATE fact_ad_daily SET platform_ic = platform_ic / 3
  WHERE platform_ic IS NOT NULL AND (load_id IS NULL OR substr(load_id, instr(load_id, '@') + 1) < '2026-09-22');
UPDATE fact_ad_daily SET platform_purchases = platform_purchases / 3
  WHERE platform_purchases IS NOT NULL AND (load_id IS NULL OR substr(load_id, instr(load_id, '@') + 1) < '2026-09-22');
UPDATE fact_ad_daily SET platform_revenue = platform_revenue / 3.0
  WHERE platform_revenue IS NOT NULL AND (load_id IS NULL OR substr(load_id, instr(load_id, '@') + 1) < '2026-09-22');
