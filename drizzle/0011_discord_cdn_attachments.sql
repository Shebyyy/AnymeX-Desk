-- Batch: Discord CDN attachments & polling state
-- Allows storing Discord CDN URLs for attachments that originated from Discord
-- Tracks when each thread was last polled to avoid re-processing old messages

ALTER TABLE attachments ADD COLUMN discord_cdn_url TEXT;
ALTER TABLE reports ADD COLUMN discord_last_polled_at INTEGER;
ALTER TABLE reports ADD COLUMN discord_last_message_id TEXT;
