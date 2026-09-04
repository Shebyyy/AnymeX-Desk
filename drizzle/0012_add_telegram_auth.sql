-- Migration 0012: Add Telegram auth and DM notification fields to users table
ALTER TABLE users ADD COLUMN telegram_id TEXT;
ALTER TABLE users ADD COLUMN telegram_username TEXT;
ALTER TABLE users ADD COLUMN telegram_photo_url TEXT;
ALTER TABLE users ADD COLUMN notify_telegram INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN notify_discord INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id_idx ON users (telegram_id);
