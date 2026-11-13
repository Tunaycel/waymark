CREATE TABLE "commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"branch" text NOT NULL,
	"message" text NOT NULL,
	"author_name" text NOT NULL,
	"author_username" text,
	"committed_at" timestamp with time zone NOT NULL,
	"url" text NOT NULL,
	"files" jsonb NOT NULL,
	"triage" jsonb,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"is_private" boolean NOT NULL,
	"installation_id" bigint,
	"last_push_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commits_repository_sha_key" ON "commits" USING btree ("repository_id","sha");--> statement-breakpoint
CREATE INDEX "commits_repository_committed_at_idx" ON "commits" USING btree ("repository_id","committed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_github_id_key" ON "repositories" USING btree ("github_id");