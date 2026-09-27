-- Creative attributes read off the ad's own name.
--
-- The ads are named to a strict convention: "Product | Shot | Format | Version",
-- e.g. "Coddiwomple City Tee | Chest Print Detail | Static | V2". That is enough to
-- answer "video or static", "flatlay or on-model" without anyone tagging anything.
--
-- Kept in their own columns, never in angle/format, because those belong to the
-- tagging layer a human owns and the loader must never overwrite. Reads take
-- COALESCE(manual, derived), so a hand-set tag always wins and a rename cannot
-- silently rewrite months of classification.
ALTER TABLE dim_ad ADD COLUMN format_derived TEXT;   -- Static | Video | Carousel
ALTER TABLE dim_ad ADD COLUMN shot_derived TEXT;     -- Flatlay, Model Front, Hip Detail…
ALTER TABLE dim_ad ADD COLUMN version_derived TEXT;  -- V1, V2…
