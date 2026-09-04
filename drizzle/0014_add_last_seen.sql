ALTER TABLE users ADD COLUMN last_seen integer DEFAULT (unixepoch());
UPDATE users SET last_seen = (unixepoch()) WHERE last_seen IS NULL;
