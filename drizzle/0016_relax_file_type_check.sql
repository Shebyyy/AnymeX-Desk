-- Migration 0016: relax the CHECK constraint on attachments.file_type.
--
-- The initial migration (0000) created the column with
--   CHECK(file_type IN ('image', 'video'))
-- but the app now accepts any file type (PDF, zip, logs, etc.), tagging those
-- as file_type='file'. SQLite won't let us ALTER a CHECK constraint in place,
-- so we do the standard table-rebuild: create a new table without the CHECK,
-- copy the rows across, drop the old table, and rename.

CREATE TABLE `attachments_new` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `report_id` INTEGER NOT NULL REFERENCES `reports`(`id`) ON DELETE CASCADE,
  `comment_id` INTEGER,
  `file_name` TEXT NOT NULL,
  `file_path` TEXT NOT NULL,
  `file_type` TEXT NOT NULL,
  `mime_type` TEXT NOT NULL,
  `file_size` INTEGER NOT NULL,
  `width` INTEGER,
  `height` INTEGER,
  `thumbnail_path` TEXT,
  `sort_order` INTEGER NOT NULL DEFAULT 0,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch()),
  `discord_cdn_url` TEXT
);

INSERT INTO `attachments_new` (
  id, report_id, comment_id, file_name, file_path, file_type, mime_type,
  file_size, width, height, thumbnail_path, sort_order, created_at, discord_cdn_url
)
SELECT
  id, report_id, comment_id, file_name, file_path, file_type, mime_type,
  file_size, width, height, thumbnail_path, sort_order, created_at, discord_cdn_url
FROM `attachments`;

DROP TABLE `attachments`;
ALTER TABLE `attachments_new` RENAME TO `attachments`;

-- Recreate the indexes that the original table had (they were dropped with it).
CREATE INDEX IF NOT EXISTS `attachments_by_report` ON `attachments` (`report_id`, `sort_order`);
CREATE INDEX IF NOT EXISTS `attachments_by_comment` ON `attachments` (`comment_id`);
