CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'declined', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_run_status" AS ENUM('queued', 'running', 'waiting_for_approval', 'waiting_for_input', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"channel_id" text,
	"requested_for_user_id" text NOT NULL,
	"decided_by_user_id" text,
	"bot_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"fingerprint" text NOT NULL,
	"policy_rule" text,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text,
	"thread_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"title" text NOT NULL,
	"status" "task_run_status" DEFAULT 'queued' NOT NULL,
	"parent_run_id" uuid,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_policy" ADD COLUMN "approve" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run_events" ADD CONSTRAINT "task_run_events_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_user_status_idx" ON "approval_requests" USING btree ("requested_for_user_id","status");--> statement-breakpoint
CREATE INDEX "approval_requests_run_status_idx" ON "approval_requests" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "approval_requests_fingerprint_idx" ON "approval_requests" USING btree ("requested_for_user_id","bot_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "task_run_events_run_sequence_idx" ON "task_run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "task_runs_channel_created_idx" ON "task_runs" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "task_runs_actor_status_idx" ON "task_runs" USING btree ("actor_user_id","status");