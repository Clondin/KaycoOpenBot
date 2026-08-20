CREATE TYPE "public"."delegation_status" AS ENUM('queued', 'accepted', 'in_progress', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('preference', 'fact', 'instruction', 'decision');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('user', 'agent', 'project');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('task', 'approval', 'delegation', 'routine', 'system');--> statement-breakpoint
CREATE TYPE "public"."project_member_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."routine_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."routine_trigger" AS ENUM('manual', 'schedule', 'webhook');--> statement-breakpoint
CREATE TABLE "delegation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delegation_id" uuid NOT NULL,
	"sender_user_id" text,
	"sender_agent_id" text,
	"kind" text DEFAULT 'note' NOT NULL,
	"body" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text NOT NULL,
	"source_agent_id" text,
	"target_agent_id" text NOT NULL,
	"source_channel_id" text,
	"target_channel_id" text NOT NULL,
	"task_run_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expected_output" text DEFAULT '' NOT NULL,
	"status" "delegation_status" DEFAULT 'queued' NOT NULL,
	"result" text,
	"error" text,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"agent_id" text,
	"project_id" uuid,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"target_url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_agents" (
	"project_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"added_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_agents_project_id_agent_id_pk" PRIMARY KEY("project_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "project_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" text,
	"title" text NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "project_member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"routine_id" uuid NOT NULL,
	"task_run_id" uuid,
	"scheduled_for" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instruction" text NOT NULL,
	"status" "routine_status" DEFAULT 'active' NOT NULL,
	"trigger" "routine_trigger" DEFAULT 'manual' NOT NULL,
	"schedule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"webhook_token_hash" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delegation_messages" ADD CONSTRAINT "delegation_messages_delegation_id_delegations_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."delegations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_messages" ADD CONSTRAINT "delegation_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_messages" ADD CONSTRAINT "delegation_messages_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_source_channel_id_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_target_channel_id_channels_id_fk" FOREIGN KEY ("target_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agents" ADD CONSTRAINT "project_agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agents" ADD CONSTRAINT "project_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agents" ADD CONSTRAINT "project_agents_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_artifacts" ADD CONSTRAINT "project_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_artifacts" ADD CONSTRAINT "project_artifacts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_artifacts" ADD CONSTRAINT "project_artifacts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_dispatches" ADD CONSTRAINT "routine_dispatches_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_dispatches" ADD CONSTRAINT "routine_dispatches_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delegation_messages_delegation_created_idx" ON "delegation_messages" USING btree ("delegation_id","created_at");--> statement-breakpoint
CREATE INDEX "delegations_actor_status_idx" ON "delegations" USING btree ("actor_user_id","status");--> statement-breakpoint
CREATE INDEX "delegations_target_status_idx" ON "delegations" USING btree ("target_agent_id","status");--> statement-breakpoint
CREATE INDEX "memory_entries_owner_scope_updated_idx" ON "memory_entries" USING btree ("owner_user_id","scope","updated_at");--> statement-breakpoint
CREATE INDEX "memory_entries_agent_idx" ON "memory_entries" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "memory_entries_project_idx" ON "memory_entries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "notifications_user_read_created_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "project_artifacts_project_updated_idx" ON "project_artifacts" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "projects_owner_status_idx" ON "projects" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_dispatches_routine_scheduled_idx" ON "routine_dispatches" USING btree ("routine_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_dispatches_task_run_idx" ON "routine_dispatches" USING btree ("task_run_id");--> statement-breakpoint
CREATE INDEX "routines_owner_status_idx" ON "routines" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "routines_due_idx" ON "routines" USING btree ("status","next_run_at");