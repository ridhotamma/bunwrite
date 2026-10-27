CREATE TABLE `_collections` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`database_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`document_security` integer DEFAULT true NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`attributes` text DEFAULT '[]' NOT NULL,
	`indexes` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_collections_db_id` ON `_collections` (`database_id`,`id`);--> statement-breakpoint
CREATE TABLE `_databases` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_databases_id_unique` ON `_databases` (`id`);--> statement-breakpoint
CREATE TABLE `_memberships` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`roles` text DEFAULT '[]' NOT NULL,
	`invited` text NOT NULL,
	`joined` text,
	`confirm` integer DEFAULT false NOT NULL,
	`secret_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `_teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_memberships_id_unique` ON `_memberships` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_memberships_team_user` ON `_memberships` (`team_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `_memberships_user` ON `_memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `_sessions` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`provider` text NOT NULL,
	`provider_uid` text DEFAULT '' NOT NULL,
	`provider_access_token` text DEFAULT '' NOT NULL,
	`provider_access_token_expiry` text DEFAULT '' NOT NULL,
	`provider_refresh_token` text DEFAULT '' NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`factors` text DEFAULT '[]' NOT NULL,
	`expire` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_sessions_id_unique` ON `_sessions` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_sessions_secret_hash_unique` ON `_sessions` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `_sessions_user` ON `_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `_teams` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`prefs` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_teams_id_unique` ON `_teams` (`id`);--> statement-breakpoint
CREATE TABLE `_tokens` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`secret_hash` text NOT NULL,
	`expire` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_tokens_id_unique` ON `_tokens` (`id`);--> statement-breakpoint
CREATE INDEX `_tokens_user` ON `_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `_transaction_logs` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_seq` integer NOT NULL,
	`database_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`document_id` text,
	`action` text NOT NULL,
	`data` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`transaction_seq`) REFERENCES `_transactions`(`seq`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `_transaction_logs_tx` ON `_transaction_logs` (`transaction_seq`);--> statement-breakpoint
CREATE TABLE `_transactions` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`status` text NOT NULL,
	`operations` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_transactions_id_unique` ON `_transactions` (`id`);--> statement-breakpoint
CREATE TABLE `_users` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text,
	`phone` text,
	`password` text,
	`hash` text DEFAULT 'argon2' NOT NULL,
	`hash_options` text DEFAULT '{}' NOT NULL,
	`registration` text NOT NULL,
	`status` integer DEFAULT true NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`password_update` text,
	`email_verification` integer DEFAULT false NOT NULL,
	`phone_verification` integer DEFAULT false NOT NULL,
	`mfa` integer DEFAULT false NOT NULL,
	`prefs` text DEFAULT '{}' NOT NULL,
	`accessed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_users_id_unique` ON `_users` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_users_email_unique` ON `_users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `_users_phone_unique` ON `_users` (`phone`);