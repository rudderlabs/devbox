SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_key_lower_uniq" ON "tasks" USING btree (lower("key"));--> statement-breakpoint
DROP INDEX "tasks_key_uniq";