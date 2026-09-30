ALTER TABLE users ADD COLUMN chat_banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN chat_ban_reason TEXT;
ALTER TABLE users ADD COLUMN timed_out_until INTEGER;
ALTER TABLE users ADD COLUMN timeout_reason TEXT;

CREATE TABLE IF NOT EXISTS chat_moderation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_user_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  duration_seconds INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_chat_mod_logs_target ON chat_moderation_logs(target_user_id);
CREATE INDEX IF NOT EXISTS idx_chat_mod_logs_actor ON chat_moderation_logs(actor_user_id);
