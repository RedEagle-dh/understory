DROP INDEX `advisory_ranges_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `advisory_ranges_unique` ON `advisory_ranges` (`advisory_id`,`ecosystem`,`package_name`,`vulnerable_range`);--> statement-breakpoint
ALTER TABLE `dependency_sets` ADD `ecosystem` text DEFAULT 'npm' NOT NULL;