CREATE TABLE `_site_deployments` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`site_id` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`build_logs` text DEFAULT '' NOT NULL,
	`build_duration` real DEFAULT 0 NOT NULL,
	`source_size` integer DEFAULT 0 NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`total_size` integer DEFAULT 0 NOT NULL,
	`activate` integer DEFAULT false NOT NULL,
	`chunks_total` integer DEFAULT 1 NOT NULL,
	`chunks_uploaded` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_site_deployments_id_unique` ON `_site_deployments` (`id`);--> statement-breakpoint
CREATE INDEX `_site_deployments_site` ON `_site_deployments` (`site_id`,`seq`);--> statement-breakpoint
CREATE TABLE `_sites` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`framework` text DEFAULT 'other' NOT NULL,
	`output_directory` text DEFAULT '' NOT NULL,
	`fallback_file` text DEFAULT '' NOT NULL,
	`deployment_id` text DEFAULT '' NOT NULL,
	`domain` text DEFAULT '' NOT NULL,
	`api_function_id` text DEFAULT '' NOT NULL,
	`install_command` text DEFAULT '' NOT NULL,
	`build_command` text DEFAULT '' NOT NULL,
	`build_runtime` text DEFAULT '' NOT NULL,
	`adapter` text DEFAULT 'static' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_sites_id_unique` ON `_sites` (`id`);