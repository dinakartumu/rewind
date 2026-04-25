-- Pipeline bug fix backfill (see same-commit src/services/images/pipeline.ts):
-- when a `source='none'` placeholder was overwritten by a real image fetch,
-- imageVersion was carried forward as 0 (the placeholder sentinel) instead
-- of being promoted to 1. The CDN URL keeps emitting `?v=0` which is the
-- visible symptom. Promote these rows to version 1 so they look the same
-- as natively-fetched images.
UPDATE images
SET image_version = 1
WHERE image_version = 0
  AND source != 'none';
