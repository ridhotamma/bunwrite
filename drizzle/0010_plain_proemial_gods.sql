CREATE TABLE `_organization_members` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'developer' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`invite_hash` text,
	`invited_at` text NOT NULL,
	`joined_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_organization_members_id_unique` ON `_organization_members` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_organization_members_email` ON `_organization_members` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `_organization_members_org` ON `_organization_members` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_organization_members_invite` ON `_organization_members` (`invite_hash`);--> statement-breakpoint
CREATE TABLE `_organizations` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_organizations_id_unique` ON `_organizations` (`id`);