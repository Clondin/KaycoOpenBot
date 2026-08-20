CREATE TABLE "codex_thread_mappings" (
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"intelligence_thread_id" text NOT NULL,
	"codex_thread_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "codex_thread_mappings_user_id_agent_id_intelligence_thread_id_pk" PRIMARY KEY("user_id","agent_id","intelligence_thread_id")
);
--> statement-breakpoint
ALTER TABLE "codex_thread_mappings" ADD CONSTRAINT "codex_thread_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_thread_mappings" ADD CONSTRAINT "codex_thread_mappings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;