CREATE TABLE `_deployments` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`function_id` text NOT NULL,
	`entrypoint` text NOT NULL,
	`commands` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`build_logs` text DEFAULT '' NOT NULL,
	`build_duration` real DEFAULT 0 NOT NULL,
	`source_size` integer DEFAULT 0 NOT NULL,
	`activate` integer DEFAULT false NOT NULL,
	`chunks_total` integer DEFAULT 1 NOT NULL,
	`chunks_uploaded` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_deployments_id_unique` ON `_deployments` (`id`);--> statement-breakpoint
CREATE INDEX `_deployments_function` ON `_deployments` (`function_id`);--> statement-breakpoint
ALTER TABLE `_functions` ADD `commands` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_functions` ADD `logging` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `_functions` ADD `deployment_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_functions` ADD `build_specification` text DEFAULT 's-1vcpu-512mb' NOT NULL;--> statement-breakpoint
ALTER TABLE `_functions` ADD `runtime_specification` text DEFAULT 's-1vcpu-512mb' NOT NULL;--> statement-breakpoint
ALTER TABLE `_functions` ADD `deployment_retention` integer DEFAULT 0 NOT NULL;