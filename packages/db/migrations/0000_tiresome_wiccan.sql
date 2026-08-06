CREATE TABLE `advisories` (
	`id` text PRIMARY KEY NOT NULL,
	`summary` text NOT NULL,
	`details` text,
	`severity` text NOT NULL,
	`cvss_score` real,
	`cvss_vector` text,
	`cwe_ids_json` text,
	`url` text,
	`published_at` integer,
	`modified_at` integer,
	`withdrawn_at` integer,
	`raw_json` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `advisory_aliases` (
	`alias` text PRIMARY KEY NOT NULL,
	`advisory_id` text NOT NULL,
	FOREIGN KEY (`advisory_id`) REFERENCES `advisories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `advisory_aliases_advisory_id_idx` ON `advisory_aliases` (`advisory_id`);--> statement-breakpoint
CREATE TABLE `advisory_ranges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`advisory_id` text NOT NULL,
	`ecosystem` text DEFAULT 'npm' NOT NULL,
	`package_name` text NOT NULL,
	`vulnerable_range` text NOT NULL,
	`first_patched` text,
	FOREIGN KEY (`advisory_id`) REFERENCES `advisories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `advisory_ranges_package_name_idx` ON `advisory_ranges` (`package_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `advisory_ranges_unique` ON `advisory_ranges` (`advisory_id`,`package_name`,`vulnerable_range`);--> statement-breakpoint
CREATE TABLE `advisory_sources` (
	`advisory_id` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`source_modified_at` integer,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`advisory_id`, `source`),
	FOREIGN KEY (`advisory_id`) REFERENCES `advisories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `dependency_status` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workspace` text DEFAULT '' NOT NULL,
	`package_name` text NOT NULL,
	`current_version` text NOT NULL,
	`declared_range` text,
	`wanted_version` text,
	`latest_version` text,
	`is_direct` integer NOT NULL,
	`dep_type` text NOT NULL,
	`update_kind` text DEFAULT 'none' NOT NULL,
	`deprecated_message` text,
	`previous_latest_version` text,
	`latest_changed_at` integer,
	`last_checked_at` integer NOT NULL,
	`last_seen_scan_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_status_unique` ON `dependency_status` (`project_id`,`workspace`,`package_name`);--> statement-breakpoint
CREATE INDEX `dependency_status_project_id_update_kind_idx` ON `dependency_status` (`project_id`,`update_kind`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`advisory_id` text NOT NULL,
	`package_name` text NOT NULL,
	`package_version` text NOT NULL,
	`workspace` text DEFAULT '' NOT NULL,
	`severity` text NOT NULL,
	`is_direct` integer NOT NULL,
	`dep_type` text NOT NULL,
	`state` text NOT NULL,
	`fixed_in` text,
	`fix_type` text,
	`fix_within_range` integer,
	`first_seen_scan_id` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_scan_id` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	`resolved_scan_id` text,
	`resolved_at` integer,
	`notified_at` integer,
	`ignored_by` text,
	`ignored_at` integer,
	`ignore_reason` text,
	`ignore_until` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`advisory_id`) REFERENCES `advisories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_unique` ON `findings` (`project_id`,`advisory_id`,`package_name`,`package_version`);--> statement-breakpoint
CREATE INDEX `findings_project_id_state_severity_idx` ON `findings` (`project_id`,`state`,`severity`);--> statement-breakpoint
CREATE INDEX `findings_first_seen_scan_id_idx` ON `findings` (`first_seen_scan_id`);--> statement-breakpoint
CREATE INDEX `findings_resolved_scan_id_idx` ON `findings` (`resolved_scan_id`);--> statement-breakpoint
CREATE TABLE `peer_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`package_name` text NOT NULL,
	`required_by` text NOT NULL,
	`required_by_version` text NOT NULL,
	`required_range` text NOT NULL,
	`resolved_version` text,
	`kind` text NOT NULL,
	`optional` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`first_seen_scan_id` text NOT NULL,
	`last_seen_scan_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peer_issues_unique` ON `peer_issues` (`project_id`,`required_by`,`required_by_version`,`package_name`);--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config_enc` text NOT NULL,
	`config_public_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_success_at` integer,
	`last_error` text,
	`last_error_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_channels_name_unique` ON `notification_channels` (`name`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`project_id` text,
	`event_type` text NOT NULL,
	`event_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`sent_at` integer,
	`error` text,
	`payload_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_channel_id_event_key_unique` ON `notification_deliveries` (`channel_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_status_next_attempt_at_idx` ON `notification_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `notification_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`project_id` text DEFAULT '' NOT NULL,
	`event_type` text NOT NULL,
	`min_severity` text,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_rules_unique` ON `notification_rules` (`channel_id`,`project_id`,`event_type`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`manifest_paths_json` text,
	`github_token_enc` text,
	`github_token_last4` text,
	`scan_interval_minutes` integer DEFAULT 60 NOT NULL,
	`scan_offset_seconds` integer NOT NULL,
	`next_scan_at` integer NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_scan_id` text,
	`last_success_scan_id` text,
	`last_lock_hash` text,
	`auto_pr_enabled` integer DEFAULT false NOT NULL,
	`auto_pr_min_severity` text DEFAULT 'high' NOT NULL,
	`auto_pr_max_bump` text DEFAULT 'minor' NOT NULL,
	`pr_base_branch` text,
	`pr_labels_json` text,
	`regenerate_lockfile` integer DEFAULT true NOT NULL,
	`notify_on_new_major` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_owner_repo_branch_unique` ON `projects` (`owner`,`repo`,`branch`);--> statement-breakpoint
CREATE INDEX `projects_next_scan_at_idx` ON `projects` (`next_scan_at`);--> statement-breakpoint
CREATE INDEX `projects_paused_next_scan_at_idx` ON `projects` (`paused`,`next_scan_at`);--> statement-breakpoint
CREATE TABLE `pull_request_bumps` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`package_name` text NOT NULL,
	`workspace` text DEFAULT '' NOT NULL,
	`from_range` text,
	`from_version` text,
	`to_version` text NOT NULL,
	`advisory_id` text,
	`finding_id` text,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`advisory_id`) REFERENCES `advisories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pull_request_bumps_pull_request_id_idx` ON `pull_request_bumps` (`pull_request_id`);--> statement-breakpoint
CREATE INDEX `pull_request_bumps_package_name_idx` ON `pull_request_bumps` (`package_name`);--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`number` integer,
	`url` text,
	`branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	`commit_sha` text,
	`lockfile_updated` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`merged_at` integer,
	`closed_at` integer,
	`last_synced_at` integer,
	`error_message` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_project_id_branch_unique` ON `pull_requests` (`project_id`,`branch`);--> statement-breakpoint
CREATE INDEX `pull_requests_project_id_state_idx` ON `pull_requests` (`project_id`,`state`);--> statement-breakpoint
CREATE TABLE `dependency_set_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`set_id` text NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`workspace` text DEFAULT '' NOT NULL,
	`dep_type` text NOT NULL,
	`is_direct` integer NOT NULL,
	`depth` integer NOT NULL,
	`declared_range` text,
	`peer_deps_json` text,
	`resolved` text,
	FOREIGN KEY (`set_id`) REFERENCES `dependency_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dependency_set_entries_set_id_name_idx` ON `dependency_set_entries` (`set_id`,`name`);--> statement-breakpoint
CREATE INDEX `dependency_set_entries_set_id_is_direct_idx` ON `dependency_set_entries` (`set_id`,`is_direct`);--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_set_entries_unique` ON `dependency_set_entries` (`set_id`,`workspace`,`name`,`version`,`dep_type`);--> statement-breakpoint
CREATE TABLE `dependency_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`lock_hash` text NOT NULL,
	`manager` text NOT NULL,
	`package_count` integer NOT NULL,
	`direct_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	`first_scan_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_sets_project_id_lock_hash_unique` ON `dependency_sets` (`project_id`,`lock_hash`);--> statement-breakpoint
CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`commit_sha` text,
	`branch` text,
	`dependency_set_id` text,
	`lock_hash` text,
	`deps_reused` integer DEFAULT false NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`total_deps` integer,
	`direct_deps` integer,
	`peer_deps` integer,
	`vuln_critical` integer,
	`vuln_high` integer,
	`vuln_moderate` integer,
	`vuln_low` integer,
	`outdated_count` integer,
	`major_outdated_count` integer,
	`new_findings` integer,
	`resolved_findings` integer,
	`error_code` text,
	`error_message` text,
	`triggered_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scans_project_id_started_at_idx` ON `scans` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `scans_status_idx` ON `scans` (`status`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`setup_completed_at` integer,
	`default_scan_interval_minutes` integer DEFAULT 60 NOT NULL,
	`retention_scans_per_project` integer DEFAULT 200 NOT NULL,
	`retention_delivery_days` integer DEFAULT 90 NOT NULL,
	`github_default_token_enc` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`meta_json` text,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_created_at_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `registry_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`etag` text,
	`body_json` text,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `registry_cache_expires_at_idx` ON `registry_cache` (`expires_at`);