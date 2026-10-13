CREATE TYPE "RoundCategory" AS ENUM ('office', 'committee');

ALTER TABLE "rounds"
  ADD COLUMN "category" "RoundCategory" NOT NULL DEFAULT 'office',
  ADD COLUMN "committee_type" TEXT,
  ADD COLUMN "member_count" INTEGER,
  ADD COLUMN "decision_note" TEXT;

ALTER TABLE "rounds"
  ADD CONSTRAINT "rounds_member_count_positive" CHECK ("member_count" IS NULL OR "member_count" > 0),
  ADD CONSTRAINT "rounds_committee_metadata_check" CHECK (
    ("category" = 'office' AND "committee_type" IS NULL AND "member_count" IS NULL AND "decision_note" IS NULL)
    OR ("category" = 'committee' AND "committee_type" IS NOT NULL)
  );
