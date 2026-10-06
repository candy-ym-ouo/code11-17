import { Router } from 'express';
import {
  approveCleanupSchema,
  cancelCleanupSchema,
  cleanupPreviewSchema,
  updatePoliciesSchema,
  updateQuotaSchema,
} from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validation';
import * as storageAdmin from '../services/storageAdminService';
import * as cleanup from '../services/cleanupService';
import { getEffectivePolicies } from '../services/storagePolicyService';
import { loadMediaForUser } from '../services/mediaService';
import { itemWithAccess } from '../services/permissionService';
import { forbidden } from '../http/errors';

function serializeRun(run: {
  id: string;
  status: string;
  totalFiles: number;
  totalBytes: bigint;
  tierFiles: number;
  tierBytes: bigint;
  deleteFiles: number;
  deleteBytes: bigint;
  note: string | null;
  result: unknown;
  createdAt: Date;
  expiresAt: Date | null;
  executedAt: Date | null;
}) {
  return {
    id: run.id,
    status: run.status,
    note: run.note,
    totalFiles: run.totalFiles,
    totalBytes: Number(run.totalBytes),
    tierFiles: run.tierFiles,
    tierBytes: Number(run.tierBytes),
    deleteFiles: run.deleteFiles,
    deleteBytes: Number(run.deleteBytes),
    result: run.result,
    createdAt: run.createdAt.toISOString(),
    expiresAt: run.expiresAt?.toISOString() ?? null,
    executedAt: run.executedAt?.toISOString() ?? null,
  };
}

export const storageRouter = Router({ mergeParams: true });

// ── 用量与配额 ──────────────────────────────────────────────

storageRouter.get(
  '/overview',
  requireFamily('storage:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json(await storageAdmin.getOverview(ctx.familyId));
  }),
);

storageRouter.put(
  '/quota',
  requireFamily('storage:manage'),
  writeLimiter,
  validateBody(updateQuotaSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const overview = await storageAdmin.updateQuota(ctx, user.id, req.body, clientMeta(req));
    res.json(overview);
  }),
);

// ── 按媒体类型的保留/分层策略 ───────────────────────────────

storageRouter.get(
  '/policies',
  requireFamily('storage:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const policies = await getEffectivePolicies(ctx.familyId);
    res.json({
      policies: policies.map((p) => ({
        kind: p.kind,
        hotDays: p.hotDays,
        maxAgeDays: p.maxAgeDays,
        onlyArchived: p.onlyArchived,
        enabled: p.enabled,
        isDefault: p.isDefault,
        updatedAt: p.isDefault ? null : p.updatedAt.toISOString(),
      })),
    });
  }),
);

storageRouter.put(
  '/policies',
  requireFamily('storage:manage'),
  writeLimiter,
  validateBody(updatePoliciesSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await storageAdmin.updatePoliciesWithAudit(ctx, user.id, req.body.policies, clientMeta(req));
    const policies = await getEffectivePolicies(ctx.familyId);
    res.json({
      policies: policies.map((p) => ({
        kind: p.kind,
        hotDays: p.hotDays,
        maxAgeDays: p.maxAgeDays,
        onlyArchived: p.onlyArchived,
        enabled: p.enabled,
        isDefault: p.isDefault,
        updatedAt: p.isDefault ? null : p.updatedAt.toISOString(),
      })),
    });
  }),
);

// ── 清理：预演 → 确认 →（worker 异步执行）→ 可查结果 ────────

storageRouter.post(
  '/cleanups/preview',
  requireFamily('storage:manage'),
  writeLimiter,
  validateBody(cleanupPreviewSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const { run, plan } = await cleanup.createPreviewRun(
      { actorId: user.id, familyId: ctx.familyId, kinds: req.body.kinds, note: req.body.note },
      clientMeta(req),
    );
    res.status(201).json({
      run: serializeRun(run),
      affectedKeys: plan.map((p) => ({
        storageKey: p.storageKey,
        kind: p.kind,
        action: p.action,
        bytes: Number(p.bytes),
        reason: p.reason,
        refCount: p.media.length,
        items: p.media.map((m) => ({ mediaId: m.id, itemId: m.item.id, itemTitle: m.item.title })),
      })),
    });
  }),
);

storageRouter.get(
  '/cleanups',
  requireFamily('storage:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const runs = await cleanup.listRuns(ctx.familyId);
    res.json({ runs: runs.map(serializeRun) });
  }),
);

storageRouter.get(
  '/cleanups/:runId',
  requireFamily('storage:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const { run, items } = await cleanup.getRunWithItems(req.params.runId!, ctx.familyId);
    res.json({
      run: serializeRun(run),
      items: items.map((ci) => ({
        id: ci.id,
        mediaId: ci.mediaId,
        itemId: ci.itemId,
        kind: ci.kind,
        action: ci.action,
        byteSize: Number(ci.byteSize),
        reason: ci.reason,
        state: ci.state,
        detail: ci.detail,
        originalName: ci.media.originalName,
        tier: ci.media.tier,
      })),
    });
  }),
);

storageRouter.post(
  '/cleanups/:runId/approve',
  requireFamily('storage:manage'),
  writeLimiter,
  validateBody(approveCleanupSchema.pick({ confirm: true })),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await cleanup.approveRun(req.params.runId!, ctx.familyId, user.id, clientMeta(req));
    res.status(202).json({ runId: req.params.runId, job: 'storage_purge' });
  }),
);

storageRouter.post(
  '/cleanups/cancel',
  requireFamily('storage:manage'),
  writeLimiter,
  validateBody(cancelCleanupSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await cleanup.cancelRun(req.body.runId, ctx.familyId, user.id, clientMeta(req));
    res.status(204).end();
  }),
);

// ── 冷层取回（手动） ────────────────────────────────────────

storageRouter.post(
  '/media/:mediaId/restore',
  requireFamily('storage:read'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    // 走与读媒体相同的可见性校验，再判断是否有管理权限：取回会搬动磁盘，需要能管理该媒体
    const media = await loadMediaForUser(user.id, ctx, req.params.mediaId!);
    const { access } = await itemWithAccess(user.id, ctx, media.itemId);
    if (!access.canManageMedia) throw forbidden('没有权限取回该媒体');
    const result = await cleanup.restoreMediaToHot(user.id, ctx.familyId, req.params.mediaId!, clientMeta(req));
    res.json({ restored: result.moved, bytes: result.bytes });
  }),
);
