-- Feature 2: Reporter edits
-- Track every edit made to a report for audit/transparency.

ALTER TABLE reports ADD COLUMN edited_at INTEGER;

CREATE TABLE IF NOT EXISTS report_edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  editor_id   TEXT    NOT NULL,
  -- 'title' | 'body' | 'steps' | 'category' | 'platform'
  field       TEXT    NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS report_edits_by_report ON report_edits(report_id);
CREATE INDEX IF NOT EXISTS report_edits_by_editor ON report_edits(editor_id);
