CREATE TYPE "CommitteeStage" AS ENUM (
  'configuration_required', 'proposals', 'support', 'approval', 'election',
  'tie_break_required', 'tie_break', 'composition_ready'
);

CREATE TYPE "AssemblyRole" AS ENUM ('president', 'vice_president', 'secretary', 'treasurer', 'delegate');

ALTER TABLE "participant_sessions"
  ADD COLUMN "assembly_role" "AssemblyRole",
  ADD COLUMN "committee_eligible" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "rounds"
  ADD COLUMN "committee_stage" "CommitteeStage",
  ADD COLUMN "committee_configuration" JSONB,
  ADD COLUMN "election_seats" INTEGER,
  ADD COLUMN "committee_root_round_id" UUID REFERENCES "rounds"("id") ON DELETE CASCADE;

ALTER TABLE "ballot_options"
  ADD COLUMN "candidate_participant_id" UUID REFERENCES "participant_sessions"("id") ON DELETE RESTRICT;

CREATE TABLE "committee_proposals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "round_id" UUID NOT NULL REFERENCES "rounds"("id") ON DELETE CASCADE,
  "candidate_participant_id" UUID NOT NULL REFERENCES "participant_sessions"("id") ON DELETE RESTRICT,
  "proposed_by_participant_id" UUID NOT NULL REFERENCES "participant_sessions"("id") ON DELETE RESTRICT,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "approval_yes" INTEGER,
  "approval_no" INTEGER,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMPTZ,
  CONSTRAINT "committee_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "committee_proposals_unique_candidate" UNIQUE ("round_id", "candidate_participant_id"),
  CONSTRAINT "committee_proposals_nonnegative_approval" CHECK (
    ("approval_yes" IS NULL AND "approval_no" IS NULL) OR
    ("approval_yes" >= 0 AND "approval_no" >= 0)
  )
);

CREATE TABLE "committee_proposal_supports" (
  "proposal_id" UUID NOT NULL REFERENCES "committee_proposals"("id") ON DELETE CASCADE,
  "supporter_participant_id" UUID NOT NULL REFERENCES "participant_sessions"("id") ON DELETE CASCADE,
  "supported_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "committee_proposal_supports_pkey" PRIMARY KEY ("proposal_id", "supporter_participant_id")
);

CREATE TABLE "committee_winners" (
  "root_round_id" UUID NOT NULL REFERENCES "rounds"("id") ON DELETE CASCADE,
  "candidate_participant_id" UUID NOT NULL REFERENCES "participant_sessions"("id") ON DELETE RESTRICT,
  "source_round_id" UUID NOT NULL REFERENCES "rounds"("id") ON DELETE CASCADE,
  "order" INTEGER NOT NULL,
  CONSTRAINT "committee_winners_pkey" PRIMARY KEY ("root_round_id", "candidate_participant_id"),
  CONSTRAINT "committee_winners_order_unique" UNIQUE ("root_round_id", "order")
);

ALTER TABLE "rounds"
  ADD CONSTRAINT "rounds_election_seats_positive" CHECK ("election_seats" IS NULL OR "election_seats" > 0);

ALTER TABLE "ballot_options"
  ADD CONSTRAINT "ballot_options_candidate_unique_per_round" UNIQUE ("round_id", "candidate_participant_id");
