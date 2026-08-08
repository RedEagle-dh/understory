ALTER TABLE `advisories` ADD `epss_score` real;--> statement-breakpoint
ALTER TABLE `advisories` ADD `epss_percentile` real;--> statement-breakpoint
ALTER TABLE `advisories` ADD `kev_added_at` integer;--> statement-breakpoint
ALTER TABLE `advisories` ADD `kev_known_ransomware` integer;--> statement-breakpoint
ALTER TABLE `advisories` ADD `threat_intel_updated_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_pr_kev_override` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `findings_state_severity_idx` ON `findings` (`state`,`severity`);--> statement-breakpoint
CREATE INDEX `findings_state_package_name_idx` ON `findings` (`state`,`package_name`);--> statement-breakpoint
CREATE INDEX `dependency_set_entries_name_idx` ON `dependency_set_entries` (`name`);