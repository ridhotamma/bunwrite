CREATE TABLE `_identities` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_uid` text NOT NULL,
	`provider_email` text DEFAULT '' NOT NULL,
	`provider_access_token` text DEFAULT '' NOT NULL,
	`provider_access_token_expiry` text DEFAULT '' NOT NULL,
	`provider_refresh_token` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_identities_id_unique` ON `_identities` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_identities_provider_uid` ON `_identities` (`provider`,`provider_uid`);--> statement-breakpoint
CREATE INDEX `_identities_user` ON `_identities` (`user_id`);--> statement-breakpoint
ALTER TABLE `_tokens` ADD `provider` text;