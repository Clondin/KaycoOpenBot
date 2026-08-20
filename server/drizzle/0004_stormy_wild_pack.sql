CREATE TABLE "codex_user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"model" text,
	"effort" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"emoji" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_channel_id_message_id_emoji_user_id_pk" PRIMARY KEY("channel_id","message_id","emoji","user_id")
);
--> statement-breakpoint
ALTER TABLE "codex_user_preferences" ADD CONSTRAINT "codex_user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_reactions_channel_message_idx" ON "message_reactions" USING btree ("channel_id","message_id");