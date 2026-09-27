-- Drops that land mid-week have a PARTIAL W0: only the days from drop_date to
-- the Saturday week end carry drop traffic. Verified — the May 14 (Thu) drop
-- days. Comparing W0 across drops is therefore only valid between drops on the
-- same weekday.
--
-- Of the 2026 calendar only Jul 26 and Sep 20 are Sunday drops, so Jul 26 is
-- the ONLY clean W0 comparison basis for the winter drop.
ALTER TABLE dim_drop ADD COLUMN drop_weekday TEXT NOT NULL DEFAULT '';
ALTER TABLE dim_drop ADD COLUMN w0_is_partial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dim_drop ADD COLUMN w0_drop_days INTEGER;
