-- Migration 0015: store the normalized title in its own column so the original
-- title (with its casing and punctuation) is preserved for display, while
-- deduplication still keys off the normalized form.
--
-- Background: previously `normalizeTitle()` was applied to the title before
-- insert, so the stored title was already lowercased and stripped of
-- punctuation (e.g. "Can't Create issue" became "cant create issue"). Existing
-- rows therefore already hold the normalized value in `title`, so we copy it
-- straight across into `title_normalized` and move the dedup unique index onto
-- the new column. New inserts going forward store the original title in
-- `title` and the normalized form in `title_normalized`.

ALTER TABLE reports ADD COLUMN title_normalized TEXT NOT NULL DEFAULT '';

UPDATE reports SET title_normalized = title WHERE title_normalized = '';

-- Move the dedup unique index from `title` onto `title_normalized`.
DROP INDEX IF EXISTS reports_dedup;
CREATE UNIQUE INDEX reports_dedup ON reports (kind, category, platform, title_normalized)
  WHERE status IN ('open', 'confirmed', 'in_progress');
