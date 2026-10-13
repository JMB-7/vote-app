ALTER TABLE "assemblies" ADD COLUMN "completed_at" TIMESTAMP(3);

UPDATE "assemblies"
SET "completed_at" = "updated_at"
WHERE "status" = 'completed' AND "completed_at" IS NULL;
