ALTER TABLE `_request_logs` ADD `auth` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_request_logs` ADD `referer` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_request_logs` ADD `user_agent` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_request_logs` ADD `error` text DEFAULT '' NOT NULL;