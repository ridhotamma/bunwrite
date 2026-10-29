CREATE TABLE `_variables` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`secret` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_variables_id_unique` ON `_variables` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_variables_scope_key` ON `_variables` (`scope`,`key`);