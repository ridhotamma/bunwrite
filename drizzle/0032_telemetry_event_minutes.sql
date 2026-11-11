CREATE TABLE `_telemetry_event_minutes` (
	`project` text NOT NULL,
	`minute` text NOT NULL,
	`event` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_telemetry_event_minutes_key` ON `_telemetry_event_minutes` (`project`,`minute`,`event`);--> statement-breakpoint
CREATE INDEX `_telemetry_event_minutes_minute` ON `_telemetry_event_minutes` (`minute`);