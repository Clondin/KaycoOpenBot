CREATE TABLE "bot_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "continuity_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"agent_id" text,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"anchor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "continuity_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"through_message_id" text NOT NULL,
	"summary" text NOT NULL,
	"anchors" jsonb DEFAULT '{"items":[]}'::jsonb NOT NULL,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"source_message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"agent_id" text,
	"channel_id" text,
	"task_run_id" uuid,
	"outcome" text DEFAULT 'invoked' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" text NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"instructions" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_program_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"task_run_id" uuid,
	"status" text NOT NULL,
	"step_names" jsonb DEFAULT '{"items":[]}'::jsonb NOT NULL,
	"trace" jsonb DEFAULT '{"items":[]}'::jsonb NOT NULL,
	"output" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tool_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"steps" jsonb DEFAULT '{"items":[]}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "lifecycle_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "pinned_version" integer;--> statement-breakpoint
ALTER TABLE "delegations" ADD COLUMN "parent_delegation_id" uuid;--> statement-breakpoint
ALTER TABLE "delegations" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delegations" ADD COLUMN "max_depth" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "delegations" ADD COLUMN "max_children" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "delegations" ADD COLUMN "max_parallel" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "delegations" ADD COLUMN "budget_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "delegations" ADD COLUMN "steering_status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "delegations" ADD COLUMN "review_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "delegations" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "safeguards" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "notepad" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "blueprint_id" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "preflight_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "preflight_message" text;--> statement-breakpoint
ALTER TABLE "bot_bundles" ADD CONSTRAINT "bot_bundles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_messages" ADD CONSTRAINT "continuity_messages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_messages" ADD CONSTRAINT "continuity_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_snapshots" ADD CONSTRAINT "continuity_snapshots_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_snapshots" ADD CONSTRAINT "continuity_snapshots_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_program_runs" ADD CONSTRAINT "tool_program_runs_program_id_tool_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."tool_programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_program_runs" ADD CONSTRAINT "tool_program_runs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_program_runs" ADD CONSTRAINT "tool_program_runs_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_programs" ADD CONSTRAINT "tool_programs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_programs" ADD CONSTRAINT "tool_programs_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_bundles_owner_name_version_key" ON "bot_bundles" USING btree ("owner_user_id","name","version");--> statement-breakpoint
CREATE INDEX "bot_bundles_owner_status_idx" ON "bot_bundles" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "continuity_messages_owner_thread_message_key" ON "continuity_messages" USING btree ("owner_user_id","thread_id","message_id");--> statement-breakpoint
CREATE INDEX "continuity_messages_owner_channel_time_idx" ON "continuity_messages" USING btree ("owner_user_id","channel_id","occurred_at");--> statement-breakpoint
CREATE INDEX "continuity_snapshots_owner_channel_created_idx" ON "continuity_snapshots" USING btree ("owner_user_id","channel_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_usage_owner_used_idx" ON "skill_usage_events" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_usage_skill_used_idx" ON "skill_usage_events" USING btree ("skill_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_key" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX "skill_versions_hash_idx" ON "skill_versions" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "tool_program_runs_owner_created_idx" ON "tool_program_runs" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_programs_owner_agent_name_key" ON "tool_programs" USING btree ("owner_user_id","agent_id","name");--> statement-breakpoint
CREATE INDEX "tool_programs_owner_status_idx" ON "tool_programs" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "delegations_parent_idx" ON "delegations" USING btree ("parent_delegation_id");