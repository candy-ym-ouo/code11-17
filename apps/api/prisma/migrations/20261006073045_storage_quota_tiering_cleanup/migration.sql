/*
  Warnings:

  - Added the required column `updated_at` to the `item_media` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "StorageTier" AS ENUM ('hot', 'cold');

-- CreateEnum
CREATE TYPE "CleanupStatus" AS ENUM ('preview', 'approved', 'done', 'canceled', 'expired');

-- CreateEnum
CREATE TYPE "CleanupAction" AS ENUM ('tier', 'delete');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobType" ADD VALUE 'storage_tier';
ALTER TYPE "JobType" ADD VALUE 'storage_purge';
ALTER TYPE "JobType" ADD VALUE 'media_restore';

-- AlterTable
-- 存量行可能已有数据：先加可空列、用 created_at 回填，再收紧为 NOT NULL
ALTER TABLE "item_media" ADD COLUMN     "tier" "StorageTier" NOT NULL DEFAULT 'hot',
ADD COLUMN     "tier_changed_at" TIMESTAMP(3),
ADD COLUMN     "updated_at" TIMESTAMP(3);

UPDATE "item_media" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;

ALTER TABLE "item_media" ALTER COLUMN "updated_at" SET NOT NULL;

-- CreateTable
CREATE TABLE "storage_quotas" (
    "family_id" TEXT NOT NULL,
    "quota_bytes" BIGINT,
    "warn_ratio" DECIMAL(4,3) NOT NULL DEFAULT 0.9,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_quotas_pkey" PRIMARY KEY ("family_id")
);

-- CreateTable
CREATE TABLE "storage_policies" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "hot_days" INTEGER,
    "max_age_days" INTEGER,
    "only_archived" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cleanup_runs" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "status" "CleanupStatus" NOT NULL DEFAULT 'preview',
    "policy_snapshot" JSONB NOT NULL,
    "cutoff_at" TIMESTAMP(3) NOT NULL,
    "total_files" INTEGER NOT NULL DEFAULT 0,
    "total_bytes" BIGINT NOT NULL DEFAULT 0,
    "tier_files" INTEGER NOT NULL DEFAULT 0,
    "tier_bytes" BIGINT NOT NULL DEFAULT 0,
    "delete_files" INTEGER NOT NULL DEFAULT 0,
    "delete_bytes" BIGINT NOT NULL DEFAULT 0,
    "result" JSONB,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),

    CONSTRAINT "cleanup_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cleanup_items" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "action" "CleanupAction" NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "detail" TEXT,

    CONSTRAINT "cleanup_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storage_policies_family_id_kind_key" ON "storage_policies"("family_id", "kind");

-- CreateIndex
CREATE INDEX "cleanup_runs_family_id_status_created_at_idx" ON "cleanup_runs"("family_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "cleanup_items_run_id_idx" ON "cleanup_items"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "cleanup_items_run_id_media_id_key" ON "cleanup_items"("run_id", "media_id");

-- CreateIndex
CREATE INDEX "item_media_tier_idx" ON "item_media"("tier");

-- AddForeignKey
ALTER TABLE "storage_quotas" ADD CONSTRAINT "storage_quotas_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_policies" ADD CONSTRAINT "storage_policies_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleanup_runs" ADD CONSTRAINT "cleanup_runs_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleanup_items" ADD CONSTRAINT "cleanup_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "cleanup_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleanup_items" ADD CONSTRAINT "cleanup_items_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "item_media"("id") ON DELETE CASCADE ON UPDATE CASCADE;
