ALTER TABLE `projects` ADD `auto_bump_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_bump_max_kind` text DEFAULT 'patch' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_bump_min_release_age_hours` integer DEFAULT 72 NOT NULL;