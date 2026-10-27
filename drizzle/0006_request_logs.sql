CREATE TABLE `_request_logs` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`status` integer NOT NULL,
	`duration_ms` real DEFAULT 0 NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`project` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `_request_logs_created` ON `_request_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `_request_logs_status` ON `_request_logs` (`status`);