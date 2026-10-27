-- Query views for files and executions (see 0002_list_views.sql).
CREATE VIEW `v_files` AS SELECT
  seq AS _seq, id AS _id, created_at AS _createdAt, updated_at AS _updatedAt, permissions AS _permissions,
  bucket_id AS bucketId, name, signature, mime_type AS mimeType, size_original AS sizeOriginal,
  chunks_total AS chunksTotal, chunks_uploaded AS chunksUploaded
FROM _files;
--> statement-breakpoint
CREATE VIEW `v_executions` AS SELECT
  seq AS _seq, id AS _id, created_at AS _createdAt, updated_at AS _updatedAt, '[]' AS _permissions,
  function_id AS functionId, trigger, status, response_status_code AS responseStatusCode,
  request_method AS requestMethod, request_path AS requestPath, duration
FROM _executions;
