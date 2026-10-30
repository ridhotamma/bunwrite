CREATE INDEX `_queue_messages_lease` ON `_queue_messages` (`status`,`lease_until`);--> statement-breakpoint
CREATE INDEX `_queue_messages_completed` ON `_queue_messages` (`completed_at`);