CREATE TABLE `_vector_evaluation_runs` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`collection_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`dataset` text NOT NULL,
	`result` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`metrics` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_vector_evaluation_runs_id` ON `_vector_evaluation_runs` (`id`);--> statement-breakpoint
CREATE INDEX `_vector_evaluation_runs_collection` ON `_vector_evaluation_runs` (`collection_id`,`created_at`);