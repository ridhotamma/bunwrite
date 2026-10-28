ALTER TABLE `_site_deployments` ADD `start_command` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_sites` ADD `start_command` text DEFAULT '' NOT NULL;