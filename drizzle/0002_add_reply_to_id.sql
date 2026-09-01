-- Add replyToId to comments so comments can be threaded replies.
ALTER TABLE `comments` ADD COLUMN `reply_to_id` INTEGER;
CREATE INDEX `comments_by_reply` ON `comments` (`reply_to_id`);
