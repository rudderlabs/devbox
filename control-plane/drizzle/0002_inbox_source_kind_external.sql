SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_source_kind_external_uniq" ON "inbox" USING btree ("source","kind","external_id");