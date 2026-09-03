-- Feature 9: Comment emoji reactions.

CREATE TABLE IF NOT EXISTS comment_reactions (
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  discord_id TEXT    NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  emoji      TEXT    NOT NULL,
  PRIMARY KEY (comment_id, discord_id, emoji)
);

CREATE INDEX IF NOT EXISTS reactions_by_comment ON comment_reactions(comment_id);
