CREATE TABLE IF NOT EXISTS chat_message_reactions (
  message_id integer NOT NULL REFERENCES chat_messages(id) ON DELETE cascade,
  user_id text NOT NULL REFERENCES users(discord_id) ON DELETE cascade,
  emoji text NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS reactions_by_chat_message ON chat_message_reactions (message_id);
