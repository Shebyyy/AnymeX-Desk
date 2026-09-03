-- Feature 6: Saved search subscriptions.
-- A user can subscribe to a filter; new matching reports create notifications.

CREATE TABLE IF NOT EXISTS subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  -- null values mean "any" for that dimension
  kind       TEXT,
  category   TEXT,
  platform   TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS subscriptions_by_user ON subscriptions(user_id);
