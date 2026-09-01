-- AnymeX Bug & Suggestion Tracker — Seed data
-- Run this against a fresh D1 database.

-- Runtime settings defaults
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('min_account_age_days', '3'),
  ('webhook_url', ''),
  ('webhook_on_new_report', 'true'),
  ('webhook_vote_threshold', '10'),
  ('max_image_size', '5242880'),
  ('max_video_size', '52428800'),
  ('max_images_per_report', '5'),
  ('discord_dm_enabled', 'true'),
  ('discord_bot_token', '');
