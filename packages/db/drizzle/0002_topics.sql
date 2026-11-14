CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"repository_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_topics" (
	"repository_id" uuid NOT NULL,
	"topic_id" text NOT NULL,
	"members" jsonb NOT NULL,
	"name" text,
	"summary" text,
	"role" text,
	"provider" text,
	"model" text,
	"prompt_version" integer,
	"described_blobs" jsonb,
	"described_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_topics_repository_id_topic_id_pk" PRIMARY KEY("repository_id","topic_id")
);
--> statement-breakpoint
CREATE TABLE "snapshot_topic_edges" (
	"snapshot_id" uuid NOT NULL,
	"from_topic" text NOT NULL,
	"to_topic" text NOT NULL,
	"weight" integer NOT NULL,
	CONSTRAINT "snapshot_topic_edges_snapshot_id_from_topic_to_topic_pk" PRIMARY KEY("snapshot_id","from_topic","to_topic")
);
--> statement-breakpoint
CREATE TABLE "snapshot_topics" (
	"snapshot_id" uuid NOT NULL,
	"topic_id" text NOT NULL,
	"package" text NOT NULL,
	"directory" text NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"role" text,
	"source" text NOT NULL,
	"label" text NOT NULL,
	"file_count" integer NOT NULL,
	"test_count" integer NOT NULL,
	"line_count" integer NOT NULL,
	"languages" jsonb NOT NULL,
	"keywords" jsonb NOT NULL,
	"externals" jsonb NOT NULL,
	CONSTRAINT "snapshot_topics_snapshot_id_topic_id_pk" PRIMARY KEY("snapshot_id","topic_id")
);
--> statement-breakpoint
ALTER TABLE "repo_snapshots" ADD COLUMN "topics_built_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "snapshot_files" ADD COLUMN "symbols" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshot_files" ADD COLUMN "externals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshot_files" ADD COLUMN "topic_id" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_topics" ADD CONSTRAINT "repository_topics_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_topic_edges" ADD CONSTRAINT "snapshot_topic_edges_snapshot_id_repo_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."repo_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_topics" ADD CONSTRAINT "snapshot_topics_snapshot_id_repo_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."repo_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_created_at_idx" ON "llm_usage" USING btree ("created_at");