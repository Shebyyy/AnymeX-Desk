-- Batch 2 Feature: Roadmap & Milestones
-- Add roadmap stage ('under_review', 'planned', 'in_progress', 'shipped') and target release milestone.

ALTER TABLE reports ADD COLUMN roadmap_stage TEXT;
ALTER TABLE reports ADD COLUMN milestone TEXT;

CREATE INDEX IF NOT EXISTS reports_by_stage ON reports(roadmap_stage);
CREATE INDEX IF NOT EXISTS reports_by_milestone ON reports(milestone);
