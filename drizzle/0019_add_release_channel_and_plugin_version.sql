-- Migration 0019: add `release_channel` and `plugin_version` to reports.
--
-- `release_channel` tracks whether the reported issue occurred on 'stable' or 'beta'.
-- `plugin_version` tracks the version of the extension runtime bridge plugin
-- (https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge).

ALTER TABLE reports ADD COLUMN release_channel text NOT NULL DEFAULT 'stable';
ALTER TABLE reports ADD COLUMN plugin_version text;
