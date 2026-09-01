-- Add commentId to attachments so files can belong to comments.
ALTER TABLE `attachments` ADD COLUMN `comment_id` INTEGER;
CREATE INDEX `attachments_by_comment` ON `attachments` (`comment_id`);
