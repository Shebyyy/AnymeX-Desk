ALTER TABLE users ADD COLUMN last_seen integer DEFAULT (unixepoch());
UPDATE users SET last_seen = last_login WHERE last_seen IS NULL;
