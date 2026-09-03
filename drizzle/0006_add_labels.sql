-- Feature 5: Staff labels / tags

CREATE TABLE IF NOT EXISTS labels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  color      TEXT    NOT NULL DEFAULT '#6b7280',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS report_labels (
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  label_id  INTEGER NOT NULL REFERENCES labels(id)  ON DELETE CASCADE,
  PRIMARY KEY (report_id, label_id)
);

CREATE INDEX IF NOT EXISTS report_labels_by_label  ON report_labels(label_id);
CREATE INDEX IF NOT EXISTS report_labels_by_report ON report_labels(report_id);

-- Seed a few starter labels so the dashboard doesn't look empty.
INSERT OR IGNORE INTO labels (name, color) VALUES
  ('regression',    '#ef4444'),
  ('upstream',      '#8b5cf6'),
  ('needs-repro',   '#f59e0b'),
  ('good-first-fix','#10b981');
