ALTER TABLE "task_runs" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "output" text;--> statement-breakpoint
CREATE INDEX "task_runs_queue_idx" ON "task_runs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "task_runs_lease_idx" ON "task_runs" USING btree ("status","lease_expires_at");