ALTER TABLE "agent_profiles" ADD COLUMN "callback_token_hash" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "callback_token_issued_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_callback_token_hash_idx" ON "agent_profiles" USING btree ("callback_token_hash");