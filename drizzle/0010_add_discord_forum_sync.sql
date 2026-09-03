-- Batch 3 Feature: Discord Contributor Forum Sync
-- Add discord_thread_id and discord_starter_message_id to reports
-- Add discord_message_id and source to comments

ALTER TABLE reports ADD COLUMN discord_thread_id TEXT;
ALTER TABLE reports ADD COLUMN discord_starter_message_id TEXT;

CREATE INDEX IF NOT EXISTS reports_by_discord_thread ON reports(discord_thread_id);

ALTER TABLE comments ADD COLUMN discord_message_id TEXT;
ALTER TABLE comments ADD COLUMN source TEXT NOT NULL DEFAULT 'web';

CREATE INDEX IF NOT EXISTS comments_by_discord_message ON comments(discord_message_id);
