CREATE TYPE "public"."task_source" AS ENUM('linear', 'api');--> statement-breakpoint
CREATE SEQUENCE "public"."api_task_key_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"github_login" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "inbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"task_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"reply_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"type" text NOT NULL,
	"inbox_id" uuid,
	"seq" bigint,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source" "task_source" NOT NULL,
	"external_id" text NOT NULL,
	"key" text NOT NULL,
	"created_by" uuid,
	"title" text NOT NULL,
	"external_url" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_id" text,
	"heartbeat_at" timestamp with time zone,
	"sandbox_id" text,
	"pvc_name" text,
	"pr_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_observed_event_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_api_tokens_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."api_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_source_external_uniq" ON "inbox" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "inbox_pending_idx" ON "inbox" USING btree ("task_id") WHERE "inbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "inbox_task_created_idx" ON "inbox" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_events_task_id_id_idx" ON "task_events" USING btree ("task_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_source_external_id_uniq" ON "tasks" USING btree ("source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_key_uniq" ON "tasks" USING btree ("key");--> statement-breakpoint
CREATE INDEX "tasks_lease_idx" ON "tasks" USING btree ("heartbeat_at") WHERE "tasks"."owner_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_pr_urls_gin_idx" ON "tasks" USING gin ("pr_urls" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "tasks_owner_sandbox_idx" ON "tasks" USING btree ("owner_id") WHERE "tasks"."sandbox_id" IS NOT NULL;