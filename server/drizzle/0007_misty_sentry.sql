ALTER TABLE "connector_instances" ADD COLUMN "last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_instances" ADD COLUMN "next_sync_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_instances" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "connector_instances" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_instances" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "connector_instances_queue_idx" ON "connector_instances" USING btree ("status","next_sync_at");--> statement-breakpoint
CREATE INDEX "connector_instances_lease_idx" ON "connector_instances" USING btree ("status","lease_expires_at");