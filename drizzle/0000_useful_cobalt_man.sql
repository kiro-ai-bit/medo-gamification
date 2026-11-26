CREATE TABLE "bootstrap_state" (
	"patient_id" uuid PRIMARY KEY NOT NULL,
	"first_bootstrap_at" timestamp with time zone NOT NULL,
	"last_bootstrap_at" timestamp with time zone NOT NULL,
	"bootstrap_count" integer DEFAULT 1 NOT NULL,
	"gap_episode_open" boolean DEFAULT false NOT NULL,
	"gap_rebootstrap_used" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bootstrap_state_count_chk" CHECK ("bootstrap_state"."bootstrap_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "consumer_offsets" (
	"consumer_name" text PRIMARY KEY NOT NULL,
	"last_event_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dose_outcome_projection" (
	"dose_id" uuid PRIMARY KEY NOT NULL,
	"patient_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"actor_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"medicine_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dose_outcome_projection_outcome_chk" CHECK ("dose_outcome_projection"."outcome" IN ('taken-on-time','taken-late','skipped','missed'))
);
--> statement-breakpoint
CREATE TABLE "gamification_state" (
	"patient_id" uuid PRIMARY KEY NOT NULL,
	"harmony_points" integer NOT NULL,
	"theme_state" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gamification_state_points_chk" CHECK ("gamification_state"."harmony_points" >= 0),
	CONSTRAINT "gamification_state_theme_chk" CHECK ("gamification_state"."theme_state" IN ('Harmony','Uneasy','Horror'))
);
--> statement-breakpoint
CREATE TABLE "purge_tombstones" (
	"patient_id" uuid PRIMARY KEY NOT NULL,
	"purged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_event_markers" (
	"event_id" uuid NOT NULL,
	"action" text NOT NULL,
	"patient_id" uuid,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_event_markers_event_id_action_pk" PRIMARY KEY("event_id","action")
);
--> statement-breakpoint
CREATE INDEX "idx_projection_patient_sched" ON "dose_outcome_projection" USING btree ("patient_id","scheduled_at","dose_id");--> statement-breakpoint
CREATE INDEX "idx_projection_patient" ON "dose_outcome_projection" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_markers_processed_at" ON "processed_event_markers" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "idx_markers_patient" ON "processed_event_markers" USING btree ("patient_id");