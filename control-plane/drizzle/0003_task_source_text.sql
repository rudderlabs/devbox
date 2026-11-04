SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "source" SET DATA TYPE text USING "source"::text;--> statement-breakpoint
-- The task_source type stays for one release. Pods still running the previous
-- release keep the statements they prepared, whose source parameters have that
-- type. Comparing such a parameter with the text column needs this cast:
-- without it those statements fail until the pod restarts. A later release
-- drops the cast and the type.
CREATE CAST ("public"."task_source" AS text) WITH INOUT AS IMPLICIT;
