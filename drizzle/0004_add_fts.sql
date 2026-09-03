-- Feature 1: Full-text search
-- FTS5 external-content table backed by the reports table.
-- Content is keyed by reports.id so the triggers below keep it in sync.

CREATE VIRTUAL TABLE IF NOT EXISTS fts_reports USING fts5(
  title,
  body,
  content='reports',
  content_rowid='id'
);

-- Populate from all existing rows.
INSERT INTO fts_reports(rowid, title, body)
SELECT id, title, coalesce(body, '') FROM reports;

-- Keep in sync automatically.
CREATE TRIGGER IF NOT EXISTS fts_reports_ai
  AFTER INSERT ON reports
BEGIN
  INSERT INTO fts_reports(rowid, title, body)
  VALUES (new.id, new.title, coalesce(new.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS fts_reports_au
  AFTER UPDATE ON reports
BEGIN
  INSERT INTO fts_reports(fts_reports, rowid, title, body)
  VALUES ('delete', old.id, old.title, coalesce(old.body, ''));
  INSERT INTO fts_reports(rowid, title, body)
  VALUES (new.id, new.title, coalesce(new.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS fts_reports_ad
  AFTER DELETE ON reports
BEGIN
  INSERT INTO fts_reports(fts_reports, rowid, title, body)
  VALUES ('delete', old.id, old.title, coalesce(old.body, ''));
END;
