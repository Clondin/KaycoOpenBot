CREATE TABLE "external_channel_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"credential_id" uuid,
	"inbound_secret_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_identity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"external_conversation_id" text,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"external_message_id" text,
	"external_user_id" text,
	"external_conversation_id" text NOT NULL,
	"task_run_id" uuid,
	"body" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"source_run_id" uuid,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"agent_id" text,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"confidence" integer DEFAULT 70 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"promoted_memory_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_route_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid,
	"task_run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text,
	"name" text DEFAULT 'Default route' NOT NULL,
	"candidates" jsonb DEFAULT '{"items":[]}'::jsonb NOT NULL,
	"retryable_codes" jsonb DEFAULT '{"items":[]}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"source_run_id" uuid,
	"target_skill_id" text,
	"operation" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"instructions" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"base_hash" text,
	"proposal_hash" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied_skill_id" text,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_result_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"task_run_id" uuid,
	"agent_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"content_hash" text NOT NULL,
	"preview" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "mode" text DEFAULT 'routine' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "quiet_token" text DEFAULT 'NO_ACTION' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "delivery" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "external_channel_connections" ADD CONSTRAINT "external_channel_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_connections" ADD CONSTRAINT "external_channel_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_connections" ADD CONSTRAINT "external_channel_connections_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_connections" ADD CONSTRAINT "external_channel_connections_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identity_links" ADD CONSTRAINT "external_identity_links_connection_id_external_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."external_channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identity_links" ADD CONSTRAINT "external_identity_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_messages" ADD CONSTRAINT "external_messages_connection_id_external_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."external_channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_messages" ADD CONSTRAINT "external_messages_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suggestions" ADD CONSTRAINT "memory_suggestions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suggestions" ADD CONSTRAINT "memory_suggestions_source_run_id_task_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suggestions" ADD CONSTRAINT "memory_suggestions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suggestions" ADD CONSTRAINT "memory_suggestions_promoted_memory_id_memory_entries_id_fk" FOREIGN KEY ("promoted_memory_id") REFERENCES "public"."memory_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_route_attempts" ADD CONSTRAINT "model_route_attempts_route_id_model_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_route_attempts" ADD CONSTRAINT "model_route_attempts_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_source_run_id_task_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_target_skill_id_skills_id_fk" FOREIGN KEY ("target_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_applied_skill_id_skills_id_fk" FOREIGN KEY ("applied_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_result_artifacts" ADD CONSTRAINT "tool_result_artifacts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_result_artifacts" ADD CONSTRAINT "tool_result_artifacts_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_result_artifacts" ADD CONSTRAINT "tool_result_artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_connections_owner_status_idx" ON "external_channel_connections" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "external_connections_channel_idx" ON "external_channel_connections" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identity_connection_user_idx" ON "external_identity_links" USING btree ("connection_id","external_user_id");--> statement-breakpoint
CREATE INDEX "external_identity_openbot_user_idx" ON "external_identity_links" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_message_provider_id_idx" ON "external_messages" USING btree ("connection_id","direction","external_message_id");--> statement-breakpoint
CREATE INDEX "external_message_task_idx" ON "external_messages" USING btree ("task_run_id");--> statement-breakpoint
CREATE INDEX "external_message_outbox_idx" ON "external_messages" USING btree ("direction","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "memory_suggestions_owner_status_idx" ON "memory_suggestions" USING btree ("owner_user_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_route_attempt_run_ordinal_idx" ON "model_route_attempts" USING btree ("task_run_id","ordinal");--> statement-breakpoint
CREATE INDEX "model_routes_owner_agent_idx" ON "model_routes" USING btree ("owner_user_id","agent_id");--> statement-breakpoint
CREATE INDEX "skill_proposals_owner_status_idx" ON "skill_proposals" USING btree ("owner_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "skill_proposals_source_run_idx" ON "skill_proposals" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX "tool_result_artifacts_owner_created_idx" ON "tool_result_artifacts" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_result_artifacts_run_idx" ON "tool_result_artifacts" USING btree ("task_run_id");