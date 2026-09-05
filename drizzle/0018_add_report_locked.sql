-- Migration 0018: add a `locked` column to reports for manual thread locking.
--
-- `locked` is independent of status. Staff can toggle it on any report
-- (open or closed). When locked, members cannot comment, react, edit their
-- own comments, or attach files — but voting is NOT affected (voting is
-- gated by status alone, per existing isVotableReport logic).
--
-- Statuses fixed/wont_fix/duplicate auto-lock the conversation via the
-- isReportLocked() helper (status check + locked column), so this column
-- only needs to capture the MANUAL lock state.

ALTER TABLE reports ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
