CREATE TABLE `_buckets` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`file_security` integer DEFAULT true NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`maximum_file_size` integer DEFAULT 30000000 NOT NULL,
	`allowed_file_extensions` text DEFAULT '[]' NOT NULL,
	`compression` text DEFAULT 'none' NOT NULL,
	`encryption` integer DEFAULT false NOT NULL,
	`antivirus` integer DEFAULT false NOT NULL,
	`transformations` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_buckets_id_unique` ON `_buckets` (`id`);--> statement-breakpoint
CREATE TABLE `_executions` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`function_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`request_method` text DEFAULT 'POST' NOT NULL,
	`request_path` text DEFAULT '/' NOT NULL,
	`request_headers` text DEFAULT '[]' NOT NULL,
	`request_body` text DEFAULT '' NOT NULL,
	`response_status_code` integer DEFAULT 0 NOT NULL,
	`response_body` text DEFAULT '' NOT NULL,
	`response_headers` text DEFAULT '[]' NOT NULL,
	`logs` text DEFAULT '' NOT NULL,
	`errors` text DEFAULT '' NOT NULL,
	`duration` real DEFAULT 0 NOT NULL,
	`scheduled_at` text,
	`user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_executions_id_unique` ON `_executions` (`id`);--> statement-breakpoint
CREATE INDEX `_executions_function` ON `_executions` (`function_id`,`seq`);--> statement-breakpoint
CREATE TABLE `_files` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`bucket_id` text NOT NULL,
	`name` text NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`signature` text DEFAULT '' NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size_original` integer DEFAULT 0 NOT NULL,
	`chunks_total` integer DEFAULT 1 NOT NULL,
	`chunks_uploaded` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_files_bucket_id` ON `_files` (`bucket_id`,`id`);--> statement-breakpoint
CREATE TABLE `_functions` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`runtime` text NOT NULL,
	`entrypoint` text NOT NULL,
	`path` text NOT NULL,
	`execute` text DEFAULT '[]' NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`schedule` text DEFAULT '' NOT NULL,
	`timeout` integer DEFAULT 15 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_functions_id_unique` ON `_functions` (`id`);