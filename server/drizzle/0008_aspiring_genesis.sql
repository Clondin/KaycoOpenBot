ALTER TABLE "mcp_servers" ADD COLUMN "auth_mode" text DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "max_runtime_ms" integer DEFAULT 900000 NOT NULL;