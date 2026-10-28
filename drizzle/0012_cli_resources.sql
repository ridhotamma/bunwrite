CREATE TABLE `_topics` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`subscribe` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_topics_id_unique` ON `_topics` (`id`);--> statement-breakpoint
CREATE TABLE `_webhooks` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`tls` integer DEFAULT true NOT NULL,
	`auth_username` text DEFAULT '' NOT NULL,
	`auth_password` text DEFAULT '' NOT NULL,
	`secret` text NOT NULL,
	`logs` text DEFAULT '' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_webhooks_id_unique` ON `_webhooks` (`id`);