-- Add fields for the "extension" report kind (Report Extension Issue).
ALTER TABLE `reports` ADD COLUMN `tested_native_app` INTEGER;
ALTER TABLE `reports` ADD COLUMN `extension_names` TEXT;
ALTER TABLE `reports` ADD COLUMN `extension_repo` TEXT;
