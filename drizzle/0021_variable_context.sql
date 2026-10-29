DROP INDEX `_function_vars_fn_key`;--> statement-breakpoint
ALTER TABLE `_function_vars` ADD `context` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `_function_vars_fn_key_context` ON `_function_vars` (`function_id`,`key`,`context`);--> statement-breakpoint
DROP INDEX `_variables_scope_key`;--> statement-breakpoint
ALTER TABLE `_variables` ADD `context` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `_variables_scope_key_context` ON `_variables` (`scope`,`key`,`context`);