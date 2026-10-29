CREATE TABLE `_queue_messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`queue` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`data` text DEFAULT '' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`available_at` text NOT NULL,
	`lease_until` text,
	`idempotency_key` text,
	`result` text DEFAULT '' NOT NULL,
	`errors` text DEFAULT '' NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_queue_messages_id_unique` ON `_queue_messages` (`id`);--> statement-breakpoint
CREATE INDEX `_queue_messages_claim` ON `_queue_messages` (`queue`,`status`,`available_at`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `_queue_messages_idempotency` ON `_queue_messages` (`queue`,`idempotency_key`);--> statement-breakpoint
ALTER TABLE `_executions` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `_executions` ADD `max_attempts` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `_executions` ADD `available_at` text;--> statement-breakpoint
ALTER TABLE `_executions` ADD `lease_until` text;--> statement-breakpoint
CREATE INDEX `_executions_queue` ON `_executions` (`status`,`available_at`);