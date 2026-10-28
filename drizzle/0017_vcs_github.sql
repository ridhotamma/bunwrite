CREATE TABLE `_site_branches` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`branch` text NOT NULL,
	`slug` text NOT NULL,
	`deployment_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_site_branches_slug` ON `_site_branches` (`site_id`,`slug`);--> statement-breakpoint
CREATE TABLE `_vcs_comments` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_repository_id` text NOT NULL,
	`pull_request` integer NOT NULL,
	`comment_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_vcs_comments_pr` ON `_vcs_comments` (`provider_repository_id`,`pull_request`);--> statement-breakpoint
CREATE TABLE `_vcs_github_app` (
	`key` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`html_url` text DEFAULT '' NOT NULL,
	`client_id` text DEFAULT '' NOT NULL,
	`client_secret` text DEFAULT '' NOT NULL,
	`webhook_secret` text DEFAULT '' NOT NULL,
	`private_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_vcs_installations` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`provider_installation_id` text NOT NULL,
	`organization` text DEFAULT '' NOT NULL,
	`account_type` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_vcs_installations_id_unique` ON `_vcs_installations` (`id`);--> statement-breakpoint
CREATE TABLE `_vcs_repositories` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`provider_installation_id` text NOT NULL,
	`provider_repository_id` text NOT NULL,
	`provider_repository_name` text DEFAULT '' NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`provider_pull_request_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_vcs_repositories_id_unique` ON `_vcs_repositories` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_vcs_repositories_resource` ON `_vcs_repositories` (`project_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `_vcs_repositories_provider` ON `_vcs_repositories` (`provider_repository_id`);--> statement-breakpoint
ALTER TABLE `_deployments` ADD `type` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `_deployments` ADD `provider_repository` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_deployments` ADD `provider_branch` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_deployments` ADD `provider_commit_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_deployments` ADD `provider_commit_message` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_deployments` ADD `provider_commit_author` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_deployments` ADD `provider_commit_author_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_deployments` ADD `provider_commit_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_deployments` ADD `provider_pull_request` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `_functions` ADD `installation_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_functions` ADD `provider_repository_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_functions` ADD `provider_branch` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_functions` ADD `provider_root_directory` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_functions` ADD `provider_silent_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `_site_deployments` ADD `type` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `_site_deployments` ADD `provider_repository` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_site_deployments` ADD `provider_branch` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_site_deployments` ADD `provider_commit_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_site_deployments` ADD `provider_commit_message` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_site_deployments` ADD `provider_commit_author` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_site_deployments` ADD `provider_commit_author_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_site_deployments` ADD `provider_commit_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_site_deployments` ADD `provider_pull_request` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `_sites` ADD `installation_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_sites` ADD `provider_repository_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_sites` ADD `provider_branch` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_sites` ADD `provider_root_directory` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `_sites` ADD `provider_silent_mode` integer DEFAULT false NOT NULL;