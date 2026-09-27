-- 0030 (2026-09-22): see the creative, not only its name.
--
-- An ad row could say "Parka | Flatlay | Video | V1" and nothing else. Judging
-- creative from a name is guessing, so the thumbnail Meta already holds is stored
-- beside the numbers. It arrives on the call that already fetches each ad's
-- delivery status, so it costs no extra request.
--
-- The URLs are Meta CDN links and can expire; they are refreshed on every Meta
-- load, and the page falls back to the ad's name when an image does not load.
ALTER TABLE dim_ad ADD COLUMN thumbnail_url TEXT;
ALTER TABLE dim_ad ADD COLUMN creative_image_url TEXT;
ALTER TABLE dim_ad ADD COLUMN creative_kind TEXT;          -- image | video | unknown
ALTER TABLE dim_ad ADD COLUMN creative_checked_at TEXT;
