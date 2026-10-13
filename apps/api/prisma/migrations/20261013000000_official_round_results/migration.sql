CREATE TABLE "official_results" (
  "id" UUID NOT NULL,
  "round_id" UUID NOT NULL,
  "note" TEXT,
  "actor_ref" TEXT NOT NULL,
  "declared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  CONSTRAINT "official_results_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "official_result_options" (
  "official_result_id" UUID NOT NULL,
  "option_id" UUID NOT NULL,
  CONSTRAINT "official_result_options_pkey" PRIMARY KEY ("official_result_id", "option_id")
);

CREATE UNIQUE INDEX "official_results_round_id_key" ON "official_results"("round_id");

ALTER TABLE "official_results" ADD CONSTRAINT "official_results_round_id_fkey"
  FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "official_result_options" ADD CONSTRAINT "official_result_options_official_result_id_fkey"
  FOREIGN KEY ("official_result_id") REFERENCES "official_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "official_result_options" ADD CONSTRAINT "official_result_options_option_id_fkey"
  FOREIGN KEY ("option_id") REFERENCES "ballot_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;
