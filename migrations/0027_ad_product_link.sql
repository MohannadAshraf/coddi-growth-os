-- Which product an ad is selling, read off the ad's name.
--
-- The name's first segment is the product ("Black Bootcut Jeans | Model Side
-- Profile | Video | V1") and the catalogue spells the same thing with the brand in
-- front ("CODDIWOMPLE BLACK BOOTCUT JEANS"). Matching the two is what lets spend
-- sit beside units sold for the same product.
--
-- Derived, in its own column: promoted_product_id belongs to the tagging layer a
-- human owns, and reads take COALESCE(promoted_product_id, product_id_derived) so a
-- hand-set link always wins. product_match_method records how the link was made, so
-- a wrong one can be found rather than silently trusted.
ALTER TABLE dim_ad ADD COLUMN product_id_derived TEXT;
ALTER TABLE dim_ad ADD COLUMN product_match_method TEXT;  -- exact_tokens | near_token | ambiguous
