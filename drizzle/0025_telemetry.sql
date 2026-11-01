CREATE TABLE `_telemetry_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event` text NOT NULL,
	`distinct_id` text DEFAULT '' NOT NULL,
	`project` text DEFAULT '' NOT NULL,
	`database` text DEFAULT '' NOT NULL,
	`collection` text DEFAULT '' NOT NULL,
	`document_id` text DEFAULT '' NOT NULL,
	`properties` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `_telemetry_events_created` ON `_telemetry_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `_telemetry_events_project` ON `_telemetry_events` (`project`,`created_at`);--> statement-breakpoint
CREATE INDEX `_telemetry_events_event` ON `_telemetry_events` (`event`);--> statement-breakpoint
CREATE TABLE `_telemetry_minutes` (
	`project` text NOT NULL,
	`minute` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`duration_sum` real DEFAULT 0 NOT NULL,
	`duration_count` integer DEFAULT 0 NOT NULL,
	`b10` integer DEFAULT 0 NOT NULL,
	`b25` integer DEFAULT 0 NOT NULL,
	`b50` integer DEFAULT 0 NOT NULL,
	`b100` integer DEFAULT 0 NOT NULL,
	`b250` integer DEFAULT 0 NOT NULL,
	`b500` integer DEFAULT 0 NOT NULL,
	`b1000` integer DEFAULT 0 NOT NULL,
	`b2500` integer DEFAULT 0 NOT NULL,
	`b5000` integer DEFAULT 0 NOT NULL,
	`b10000` integer DEFAULT 0 NOT NULL,
	`bover` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_telemetry_minutes_project_minute` ON `_telemetry_minutes` (`project`,`minute`);--> statement-breakpoint
CREATE TABLE `_telemetry_spans` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text DEFAULT '' NOT NULL,
	`request_id` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`method` text NOT NULL,
	`route` text NOT NULL,
	`status` integer NOT NULL,
	`duration_ms` real NOT NULL,
	`project` text DEFAULT '' NOT NULL,
	`auth` text DEFAULT '' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`attributes` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `_telemetry_spans_created` ON `_telemetry_spans` (`created_at`);--> statement-breakpoint
CREATE INDEX `_telemetry_spans_project` ON `_telemetry_spans` (`project`,`created_at`);--> statement-breakpoint
CREATE INDEX `_telemetry_spans_route` ON `_telemetry_spans` (`route`);--> statement-breakpoint
CREATE INDEX `_request_logs_project_created` ON `_request_logs` (`project`,`created_at`);