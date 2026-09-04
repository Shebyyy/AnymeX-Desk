-- Migration 0013: Add discord_linked and discord_user_id to users table
ALTER TABLE users ADD COLUMN discord_linked INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN discord_user_id TEXT;
