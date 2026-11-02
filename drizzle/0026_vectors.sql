CREATE TABLE `_vector_collections` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`dimension` integer NOT NULL,
	`metric` text DEFAULT 'cosine' NOT NULL,
	`embedder` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_vector_collections_id` ON `_vector_collections` (`id`);--> statement-breakpoint
CREATE TABLE `_vector_points` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` text NOT NULL,
	`id` text NOT NULL,
	`document_id` text DEFAULT '' NOT NULL,
	`chunk_index` integer DEFAULT 0 NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`embedding` text NOT NULL,
	`norm` real DEFAULT 0 NOT NULL,
	`dimension` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_vector_points_collection_point` ON `_vector_points` (`collection_id`,`id`);--> statement-breakpoint
CREATE INDEX `_vector_points_collection` ON `_vector_points` (`collection_id`);--> statement-breakpoint
CREATE INDEX `_vector_points_document` ON `_vector_points` (`collection_id`,`document_id`);