ALTER TABLE `_request_logs` ADD `request_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `_request_logs` ADD `response_bytes` integer DEFAULT 0 NOT NULL;