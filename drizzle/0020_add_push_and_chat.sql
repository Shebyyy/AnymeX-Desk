CREATE TABLE IF NOT EXISTS push_subscriptions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id text NOT NULL REFERENCES users(discord_id) ON DELETE cascade,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at integer DEFAULT (unixepoch()) NOT NULL,
  last_used_at integer
);

CREATE INDEX IF NOT EXISTS push_subs_by_user ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS chat_channels (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  description text,
  icon text DEFAULT 'message-square',
  is_staff_only integer DEFAULT 0,
  position integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  channel_id text NOT NULL REFERENCES chat_channels(id) ON DELETE cascade,
  user_id text NOT NULL REFERENCES users(discord_id) ON DELETE cascade,
  body text NOT NULL,
  reply_to_id integer REFERENCES chat_messages(id) ON DELETE set null,
  tagged_report_ids text,
  attachment_count integer DEFAULT 0,
  is_pinned integer DEFAULT 0,
  created_at integer DEFAULT (unixepoch()) NOT NULL,
  updated_at integer DEFAULT (unixepoch()) NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_by_channel ON chat_messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS chat_by_reply ON chat_messages (reply_to_id);
CREATE INDEX IF NOT EXISTS chat_by_user ON chat_messages (user_id);

INSERT OR IGNORE INTO chat_channels (id, name, description, icon, is_staff_only, position) VALUES
  ('general', 'general', 'General discussion about AnymeX & Desk', 'message-square', 0, 1),
  ('support', 'support-help', 'Ask questions, get help, or report urgent issues', 'help-circle', 0, 2),
  ('features', 'feature-ideas', 'Discuss upcoming suggestions and ideas', 'sparkles', 0, 3),
  ('staff', 'staff-lounge', 'Internal team and moderator chat', 'shield', 1, 4);
