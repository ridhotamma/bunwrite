CREATE TABLE `_vector_audit_logs` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`collection_id` text NOT NULL,
	`user_id` text,
	`caller_kind` text DEFAULT 'guest' NOT NULL,
	`query` text NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`source_ids` text NOT NULL,
	`security` text NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_vector_audit_logs_id` ON `_vector_audit_logs` (`id`);--> statement-breakpoint
CREATE INDEX `_vector_audit_logs_collection` ON `_vector_audit_logs` (`collection_id`,`created_at`);