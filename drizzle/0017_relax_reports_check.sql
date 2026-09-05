-- Migration 0017: drop the stale CHECK constraints on reports.kind and reports.status.
--
-- The reports table was created in 0000_initial.sql with:
--   kind   TEXT NOT NULL CHECK(kind IN ('bug', 'suggestion'))
--   status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','confirmed','in_progress','fixed','wont_fix','duplicate'))
--
-- But the app's schema (src/lib/db/schema.ts) long ago grew to include:
--   KINDS   = ['bug', 'suggestion', 'extension']
--   STATUSES = ['open', 'under_review', 'confirmed', 'in_progress', 'fixed', 'wont_fix', 'duplicate']
--
-- No migration ever updated these CHECKs. Result: filing an extension issue
-- (kind='extension') always failed with SQLITE_CONSTRAINT_CHECK, and any
-- staff action setting status='under_review' would fail the same way.
--
-- SQLite won't ALTER a CHECK in place, so we do the standard table-rebuild:
-- create new table without the CHECKs, copy, drop old, rename, recreate
-- indexes, and recreate the FTS5 triggers (which are dropped with the table).
--
-- We drop both CHECKs entirely — the app validates kind/status in TypeScript
-- (validKinds / validPlatforms / STATUSES), so a DB-level CHECK only creates
-- this class of bug. platform's CHECK is kept because it's stable.

CREATE TABLE `reports_new` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `kind` TEXT NOT NULL,
  `category` TEXT NOT NULL,
  `platform` TEXT NOT NULL CHECK(`platform` IN ('android', 'ios', 'windows', 'macos', 'linux', 'all')),
  `app_version` TEXT,
  `title` TEXT NOT NULL,
  `body` TEXT,
  `steps_to_reproduce` TEXT,
  `status` TEXT NOT NULL DEFAULT 'open',
  `reporter_id` TEXT NOT NULL REFERENCES `users`(`discord_id`),
  `duplicate_of` INTEGER,
  `votes` INTEGER NOT NULL DEFAULT 0,
  `attachment_count` INTEGER NOT NULL DEFAULT 0,
  `comment_count` INTEGER NOT NULL DEFAULT 0,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch()),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch()),
  `status_changed_at` INTEGER,
  `announced_at` INTEGER,
  `status_note` TEXT,
  `tested_native_app` INTEGER,
  `extension_names` TEXT,
  `extension_repo` TEXT,
  `edited_at` INTEGER,
  `roadmap_stage` TEXT,
  `milestone` TEXT,
  `discord_thread_id` TEXT,
  `discord_starter_message_id` TEXT,
  `discord_last_polled_at` INTEGER,
  `discord_last_message_id` TEXT,
  `title_normalized` TEXT NOT NULL DEFAULT ''
);

-- Copy all rows across. Column order matches the SELECT.
INSERT INTO `reports_new` (
  id, kind, category, platform, app_version, title, body, steps_to_reproduce,
  status, reporter_id, duplicate_of, votes, attachment_count, comment_count,
  created_at, updated_at, status_changed_at, announced_at, status_note,
  tested_native_app, extension_names, extension_repo, edited_at,
  roadmap_stage, milestone, discord_thread_id, discord_starter_message_id,
  discord_last_polled_at, discord_last_message_id, title_normalized
)
SELECT
  id, kind, category, platform, app_version, title, body, steps_to_reproduce,
  status, reporter_id, duplicate_of, votes, attachment_count, comment_count,
  created_at, updated_at, status_changed_at, announced_at, status_note,
  tested_native_app, extension_names, extension_repo, edited_at,
  roadmap_stage, milestone, discord_thread_id, discord_starter_message_id,
  discord_last_polled_at, discord_last_message_id, title_normalized
FROM `reports`;

-- The FTS triggers (fts_reports_ai/au/ad) are attached to `reports` and are
-- dropped with the table. Drop the table now.
DROP TABLE `reports`;
ALTER TABLE `reports_new` RENAME TO `reports`;

-- Recreate all indexes. (Dropped with the old table.)
-- reports_dedup moved to title_normalized in migration 0015.
CREATE UNIQUE INDEX IF NOT EXISTS `reports_dedup` ON `reports` (`kind`, `category`, `platform`, `title_normalized`) WHERE status IN ('open', 'confirmed', 'in_progress');
CREATE INDEX IF NOT EXISTS `reports_board` ON `reports` (`status`, `kind`, `votes` DESC, `created_at`, `category`);
CREATE INDEX IF NOT EXISTS `reports_board_open` ON `reports` (`votes` DESC, `created_at`, `kind`, `category`) WHERE status IN ('open', 'confirmed', 'in_progress');
CREATE INDEX IF NOT EXISTS `reports_tallies` ON `reports` (`status`, `kind`, `created_at`);
CREATE INDEX IF NOT EXISTS `reports_by_reporter` ON `reports` (`reporter_id`);
CREATE INDEX IF NOT EXISTS `reports_by_category` ON `reports` (`category`);
CREATE INDEX IF NOT EXISTS `reports_by_platform` ON `reports` (`platform`);
CREATE INDEX IF NOT EXISTS `reports_by_age` ON `reports` (`status`, `created_at`);
CREATE INDEX IF NOT EXISTS `reports_by_discord_thread` ON `reports` (`discord_thread_id`);

-- Recreate the FTS5 sync triggers (dropped with the old table).
CREATE TRIGGER IF NOT EXISTS `fts_reports_ai`
  AFTER INSERT ON `reports`
BEGIN
  INSERT INTO `fts_reports`(rowid, title, body)
  VALUES (new.id, new.title, coalesce(new.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS `fts_reports_au`
  AFTER UPDATE ON `reports`
BEGIN
  INSERT INTO `fts_reports`(`fts_reports`, rowid, title, body)
  VALUES ('delete', old.id, old.title, coalesce(old.body, ''));
  INSERT INTO `fts_reports`(rowid, title, body)
  VALUES (new.id, new.title, coalesce(new.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS `fts_reports_ad`
  AFTER DELETE ON `reports`
BEGIN
  INSERT INTO `fts_reports`(`fts_reports`, rowid, title, body)
  VALUES ('delete', old.id, old.title, coalesce(old.body, ''));
END;
