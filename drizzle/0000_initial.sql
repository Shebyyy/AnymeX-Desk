-- AnymeX Desk: Initial schema for bug/suggestion tracking

-- Users table (mostly unchanged)
CREATE TABLE IF NOT EXISTS `users` (
  `discord_id` TEXT PRIMARY KEY NOT NULL,
  `username` TEXT NOT NULL,
  `avatar_hash` TEXT,
  `account_created_at` INTEGER NOT NULL,
  `guild_joined_at` INTEGER,
  `discord_level` TEXT CHECK(`discord_level` IN ('mod', 'admin')),
  `manual_level` TEXT CHECK(`manual_level` IN ('mod', 'admin')),
  `banned` INTEGER NOT NULL DEFAULT 0,
  `first_seen` INTEGER NOT NULL DEFAULT (unixepoch()),
  `last_login` INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Reports table (redesigned for AnymeX)
CREATE TABLE IF NOT EXISTS `reports` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `kind` TEXT NOT NULL CHECK(`kind` IN ('bug', 'suggestion')),
  `category` TEXT NOT NULL,
  `platform` TEXT NOT NULL CHECK(`platform` IN ('android', 'ios', 'windows', 'macos', 'linux', 'all')),
  `app_version` TEXT,
  `title` TEXT NOT NULL,
  `body` TEXT,
  `steps_to_reproduce` TEXT,
  `status` TEXT NOT NULL DEFAULT 'open' CHECK(`status` IN ('open', 'confirmed', 'in_progress', 'fixed', 'wont_fix', 'duplicate')),
  `reporter_id` TEXT NOT NULL REFERENCES `users`(`discord_id`),
  `duplicate_of` INTEGER,
  `votes` INTEGER NOT NULL DEFAULT 0,
  `attachment_count` INTEGER NOT NULL DEFAULT 0,
  `comment_count` INTEGER NOT NULL DEFAULT 0,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch()),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch()),
  `status_changed_at` INTEGER,
  `announced_at` INTEGER,
  `status_note` TEXT
);

-- Dedup index: one open report per kind + category + platform + title
CREATE UNIQUE INDEX IF NOT EXISTS `reports_dedup` ON `reports` (`kind`, `category`, `platform`, `title`)
  WHERE status IN ('open', 'confirmed', 'in_progress');

-- Board query index
CREATE INDEX IF NOT EXISTS `reports_board` ON `reports` (`status`, `kind`, `votes` DESC, `created_at`, `category`);

-- Partial index for default open board view
CREATE INDEX IF NOT EXISTS `reports_board_open` ON `reports` (`votes` DESC, `created_at`, `kind`, `category`)
  WHERE status IN ('open', 'confirmed', 'in_progress');

-- Header tallies covering index
CREATE INDEX IF NOT EXISTS `reports_tallies` ON `reports` (`status`, `kind`, `created_at`);

CREATE INDEX IF NOT EXISTS `reports_by_reporter` ON `reports` (`reporter_id`);
CREATE INDEX IF NOT EXISTS `reports_by_category` ON `reports` (`category`);
CREATE INDEX IF NOT EXISTS `reports_by_platform` ON `reports` (`platform`);
CREATE INDEX IF NOT EXISTS `reports_by_age` ON `reports` (`status`, `created_at`);

-- Votes table
CREATE TABLE IF NOT EXISTS `votes` (
  `report_id` INTEGER NOT NULL REFERENCES `reports`(`id`) ON DELETE CASCADE,
  `discord_id` TEXT NOT NULL REFERENCES `users`(`discord_id`) ON DELETE CASCADE,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (`report_id`, `discord_id`)
);
CREATE INDEX IF NOT EXISTS `votes_by_user` ON `votes` (`discord_id`);

-- Attachments table (NEW)
CREATE TABLE IF NOT EXISTS `attachments` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `report_id` INTEGER NOT NULL REFERENCES `reports`(`id`) ON DELETE CASCADE,
  `file_name` TEXT NOT NULL,
  `file_path` TEXT NOT NULL,
  `file_type` TEXT NOT NULL CHECK(`file_type` IN ('image', 'video')),
  `mime_type` TEXT NOT NULL,
  `file_size` INTEGER NOT NULL,
  `width` INTEGER,
  `height` INTEGER,
  `thumbnail_path` TEXT,
  `sort_order` INTEGER NOT NULL DEFAULT 0,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS `attachments_by_report` ON `attachments` (`report_id`, `sort_order`);

-- Comments table (NEW)
CREATE TABLE IF NOT EXISTS `comments` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `report_id` INTEGER NOT NULL REFERENCES `reports`(`id`) ON DELETE CASCADE,
  `user_id` TEXT NOT NULL REFERENCES `users`(`discord_id`) ON DELETE CASCADE,
  `body` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch()),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS `comments_by_report` ON `comments` (`report_id`, `created_at`);
CREATE INDEX IF NOT EXISTS `comments_by_user` ON `comments` (`user_id`);

-- Notifications table
CREATE TABLE IF NOT EXISTS `notifications` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` TEXT NOT NULL REFERENCES `users`(`discord_id`) ON DELETE CASCADE,
  `report_id` INTEGER NOT NULL REFERENCES `reports`(`id`) ON DELETE CASCADE,
  `kind` TEXT NOT NULL CHECK(`kind` IN ('status_changed', 'comment', 'duplicate', 'mentioned')),
  `detail` TEXT,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch()),
  `read_at` INTEGER
);
CREATE INDEX IF NOT EXISTS `notifications_unread` ON `notifications` (`user_id`, `read_at`);

-- Settings table
CREATE TABLE IF NOT EXISTS `settings` (
  `key` TEXT PRIMARY KEY NOT NULL,
  `value` TEXT,
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch()),
  `updated_by` TEXT
);

-- Audit log table
CREATE TABLE IF NOT EXISTS `audit` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `actor_id` TEXT NOT NULL,
  `actor_name` TEXT NOT NULL,
  `action` TEXT NOT NULL,
  `target` TEXT,
  `detail` TEXT,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS `audit_recent` ON `audit` (`created_at`);
