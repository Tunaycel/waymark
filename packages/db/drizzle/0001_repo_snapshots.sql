CREATE TABLE "repo_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer NOT NULL,
	"file_count" integer NOT NULL,
	"edge_count" integer NOT NULL,
	"truncated" boolean NOT NULL,
	"summary" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_edges" (
	"snapshot_id" uuid NOT NULL,
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	CONSTRAINT "snapshot_edges_snapshot_id_from_path_to_path_pk" PRIMARY KEY("snapshot_id","from_path","to_path")
);
--> statement-breakpoint
CREATE TABLE "snapshot_files" (
	"snapshot_id" uuid NOT NULL,
	"path" text NOT NULL,
	"language" text,
	"kind" text NOT NULL,
	"module" text NOT NULL,
	"size" integer NOT NULL,
	"lines" integer,
	"blob_sha" text,
	CONSTRAINT "snapshot_files_snapshot_id_path_pk" PRIMARY KEY("snapshot_id","path")
);
--> statement-breakpoint
ALTER TABLE "repo_snapshots" ADD CONSTRAINT "repo_snapshots_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_edges" ADD CONSTRAINT "snapshot_edges_snapshot_id_repo_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."repo_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_files" ADD CONSTRAINT "snapshot_files_snapshot_id_repo_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."repo_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_snapshots_repository_sha_key" ON "repo_snapshots" USING btree ("repository_id","commit_sha");--> statement-breakpoint
CREATE INDEX "repo_snapshots_repository_indexed_at_idx" ON "repo_snapshots" USING btree ("repository_id","indexed_at" DESC NULLS LAST);