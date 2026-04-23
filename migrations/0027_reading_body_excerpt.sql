-- Add body_excerpt column to reading_items for Tier 2 body-text FTS indexing.
-- Populated by enrichArticle at sync time (derived from the content column via
-- htmlToText) and by POST /v1/admin/backfill-body-excerpt for existing rows.
ALTER TABLE reading_items ADD COLUMN body_excerpt text;
