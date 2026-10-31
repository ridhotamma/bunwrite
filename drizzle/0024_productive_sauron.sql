CREATE TABLE `_console_mfa_challenges` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_id` integer NOT NULL,
	`secret_hash` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expire` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`admin_id`) REFERENCES `_console_admins`(`seq`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_console_mfa_challenges_secret_hash_unique` ON `_console_mfa_challenges` (`secret_hash`);--> statement-breakpoint
ALTER TABLE `_api_keys` ADD `scopes` text;--> statement-breakpoint
ALTER TABLE `_console_admins` ADD `mfa` integer DEFAULT false NOT NULL;