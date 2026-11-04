SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "source" SET DATA TYPE text USING "source"::text;--> statement-breakpoint
-- The task_source type stays for one release. Pods still running the previous
-- release keep the statements they prepared, whose source parameters have that
-- type. This cast keeps their comparisons on source working; without it they
-- fail until the pod restarts. The cast can't help a cached statement that
-- returns source inside a transaction: its result type changed, so it fails
-- once per connection and then works. A later release drops the cast and the
-- type.
CREATE CAST ("public"."task_source" AS text) WITH INOUT AS IMPLICIT;
