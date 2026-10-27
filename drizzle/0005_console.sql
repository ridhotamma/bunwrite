CREATE TABLE `_api_keys` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`hint` text NOT NULL,
	`expire` text,
	`accessed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_api_keys_id_unique` ON `_api_keys` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_api_keys_secret_hash_unique` ON `_api_keys` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `_console_admins` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_console_admins_email_unique` ON `_console_admins` (`email`);--> statement-breakpoint
CREATE TABLE `_console_sessions` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_id` integer NOT NULL,
	`secret_hash` text NOT NULL,
	`expire` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`admin_id`) REFERENCES `_console_admins`(`seq`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_console_sessions_secret_hash_unique` ON `_console_sessions` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `_function_vars` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`function_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`secret` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_function_vars_fn_key` ON `_function_vars` (`function_id`,`key`);--> statement-breakpoint
CREATE TABLE `_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
