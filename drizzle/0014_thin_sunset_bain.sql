CREATE TABLE `_proxy_rules` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`domain` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_proxy_rules_id_unique` ON `_proxy_rules` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_proxy_rules_domain_unique` ON `_proxy_rules` (`domain`);--> statement-breakpoint
CREATE INDEX `_proxy_rules_resource` ON `_proxy_rules` (`resource_type`,`resource_id`,`seq`);--> statement-breakpoint
-- The old single `_sites.domain` becomes the site's first custom domain.
INSERT INTO `_proxy_rules` (`id`, `resource_type`, `resource_id`, `domain`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(8))), 'site', `id`, `domain`, `created_at`, `updated_at` FROM `_sites` WHERE `domain` <> '';