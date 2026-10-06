-- 家庭存储配额与冷热分层
-- 1) 媒体新增冷热层与访问时间；2) 保留策略 / 配额 / 预演单三张表；3) worker 新增 storage_tier 任务。

-- CreateEnum
CREATE TYPE "MediaTier" AS ENUM ('hot', 'cold');

-- CreateEnum
CREATE TYPE "StoragePlanStatus" AS ENUM ('open', 'applied', 'failed', 'expired');

-- AlterEnum: JobType 增加 storage_tier（ADD VALUE 不能出现在事务块里，prisma migrate 会自动包裹事务，
-- 因此这里用 DO 包裹的安全写法）。
DO $$ BEGIN
    ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'storage_tier';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable: item_media
ALTER TABLE "item_media"
    ADD COLUMN "tier" "MediaTier" NOT NULL DEFAULT 'hot',
    ADD COLUMN "tiered_at" TIMESTAMP(3),
    ADD COLUMN "last_accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "item_media_tier_last_accessed_at_idx" ON "item_media" ("tier", "last_accessed_at");

-- CreateTable: storage_policies（按媒体类型的保留策略，每家庭三类各一行）
CREATE TABLE "storage_policies" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "hot_max_idle_days" INTEGER,
    "cold_retention_days" INTEGER,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "storage_policies_family_id_kind_key" ON "storage_policies" ("family_id", "kind");
CREATE INDEX "storage_policies_family_id_idx" ON "storage_policies" ("family_id");

-- CreateTable: storage_quotas（每家庭一行）
CREATE TABLE "storage_quotas" (
    "family_id" TEXT NOT NULL,
    "hot_bytes_limit" BIGINT,
    "total_bytes_limit" BIGINT,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_quotas_pkey" PRIMARY KEY ("family_id")
);

-- CreateTable: storage_plans（清理预演单）
CREATE TABLE "storage_plans" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "status" "StoragePlanStatus" NOT NULL DEFAULT 'open',
    "trigger" TEXT NOT NULL,
    "actions" JSONB NOT NULL,
    "impact" JSONB NOT NULL,
    "result" JSONB,
    "applied_by" TEXT,
    "applied_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "storage_plans_family_id_status_created_at_idx"
    ON "storage_plans" ("family_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "storage_policies" ADD CONSTRAINT "storage_policies_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "storage_quotas" ADD CONSTRAINT "storage_quotas_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "storage_plans" ADD CONSTRAINT "storage_plans_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 为既有家庭补齐默认策略（图片90天降冷/30天删、音频180天降冷/30天删、文档永久保留且受保护）。
-- updated_by 取家庭创建者；取系统第一个用户兜底（正常升级路径下家庭一定有创建者）。
INSERT INTO "storage_policies"
    ("id", "family_id", "kind", "hot_max_idle_days", "cold_retention_days", "protected", "updated_by", "updated_at")
SELECT
    replace(gen_random_uuid()::text, '-', ''),
    f."id",
    k."kind"::"MediaKind",
    k."hot_days", k."retain_days", k."protected",
    COALESCE(f."created_by", (SELECT "id" FROM "users" ORDER BY "created_at" ASC LIMIT 1), 'system'),
    CURRENT_TIMESTAMP
FROM "families" f
CROSS JOIN (VALUES
    ('image',    90,  30, FALSE),
    ('audio',   180,  30, FALSE),
    ('document', NULL, NULL, TRUE)
) AS k("kind", "hot_days", "retain_days", "protected")
WHERE f."deleted_at" IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM "storage_policies" p WHERE p."family_id" = f."id" AND p."kind" = k."kind"::"MediaKind"
  );
