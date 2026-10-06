import { Router } from 'express';
import { updateStoragePolicySchema, updateStorageQuotaSchema, createStoragePlanSchema } from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validation';
import { badRequest } from '../http/errors';
import * as settings from '../services/storageSettingsService';
import * as planService from '../services/storagePlanService';
import { previewFamily } from '../services/storagePlanService';
import { formatBytes } from '../storage/bytes';
import type { MediaKind } from '@prisma/client';

export const storageRouter = Router({ mergeParams: true });

const KINDS: MediaKind[] = ['image', 'audio', 'document'];

/** 用量 + 配额 + 保留策略，管理页一屏取齐。 */
storageRouter.get(
  '/usage',
  requireFamily('storage:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const [plan, quota, policies] = await Promise.all([
      previewFamily({ familyId: ctx.familyId }),
      settings.getQuota(ctx.familyId),
      settings.listPolicies(ctx.familyId),
    ]);
    res.json({
      usage: {
        ...plan.current,
        projected: plan.projected,
        quota: plan.quota,
        unresolvedViolations: plan.unresolvedViolations,
        human: {
          hot: formatBytes(plan.current.hotBytes),
          cold: formatBytes(plan.current.coldBytes),
          total: formatBytes(plan.current.totalBytes),
          hotLimit: formatBytes(plan.quota.hotBytesLimit),
          totalLimit: formatBytes(plan.quota.totalBytesLimit),
        },
      },
      quota,
      policies,
    });
  }),
);

/** 只读预演：返回动作清单与影响面，不落库、不动文件。 */
storageRouter.get(
  '/plan/preview',
  requireFamily('storage:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const maxActions = req.query.maxActions ? Number(req.query.maxActions) : undefined;
    if (maxActions !== undefined && (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 10_000)) {
      throw badRequest('maxActions 必须是 1–10000 的整数');
    }
    const plan = await previewFamily({ familyId: ctx.familyId, maxActions });
    res.json({ plan });
  }),
);

/** 预演并落单（不执行）。执行必须显式 POST /plans/:id/apply，把「看影响面」和「动手」强制分开。 */
storageRouter.post(
  '/plans',
  requireFamily('storage:manage'),
  writeLimiter,
  validateBody(createStoragePlanSchema),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const ctx = familyCtx(req);
    const { planId, plan } = await planService.createStoredPlan({
      familyId: ctx.familyId,
      actorId: user.id,
      trigger: 'manual',
      reason: req.body.reason ?? null,
      maxActions: req.body.maxActions,
      meta: clientMeta(req),
    });
    res.status(201).json({ planId, plan });
  }),
);

storageRouter.get(
  '/plans',
  requireFamily('storage:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const plans = await planService.listPlans(ctx.familyId, Number(req.query.limit ?? 20));
    res.json({ plans });
  }),
);

/** 执行预演单：执行前服务端会重新校验状态/过期/文件引用，防止预演后的变化造成误删。 */
storageRouter.post(
  '/plans/:planId/apply',
  requireFamily('storage:manage'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const ctx = familyCtx(req);
    const result = await planService.applyStoredPlan(req.params.planId!, ctx.familyId, user.id, clientMeta(req));
    res.json({ result });
  }),
);

storageRouter.get(
  '/plans/:planId',
  requireFamily('storage:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ plan: await planService.getPlan(ctx.familyId, req.params.planId!) });
  }),
);

storageRouter.post(
  '/plans/:planId/discard',
  requireFamily('storage:manage'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const ctx = familyCtx(req);
    const plan = await planService.discardPlan(ctx.familyId, req.params.planId!, user.id, clientMeta(req));
    res.json({ plan: { id: plan.id, status: plan.status } });
  }),
);

storageRouter.get(
  '/policies',
  requireFamily('storage:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ policies: await settings.listPolicies(ctx.familyId) });
  }),
);

storageRouter.put(
  '/policies/:kind',
  requireFamily('storage:manage'),
  writeLimiter,
  validateBody(updateStoragePolicySchema),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const ctx = familyCtx(req);
    const kind = req.params.kind as MediaKind;
    if (!KINDS.includes(kind)) throw badRequest(`媒体类型必须是 ${KINDS.join('/')} 之一`);
    const policy = await settings.updatePolicy(user.id, ctx.familyId, kind, req.body, clientMeta(req));
    res.json({ policy });
  }),
);

storageRouter.get(
  '/quota',
  requireFamily('storage:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ quota: await settings.getQuota(ctx.familyId) });
  }),
);

/**
 * 修改配额。默认保存后立即做一轮「只降冷、不删除」的自动收敛（reconcile=true），
 * 保证配额变更即时生效；传 false 则只改配置，由每日任务兜底。
 * 任何情况下都不会自动删除数据。
 */
storageRouter.put(
  '/quota',
  requireFamily('storage:manage'),
  writeLimiter,
  validateBody(updateStorageQuotaSchema),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const ctx = familyCtx(req);
    const { before, after } = await settings.updateQuota(
      user.id,
      ctx.familyId,
      {
        hotBytesLimit: req.body.hotBytesLimit,
        totalBytesLimit: req.body.totalBytesLimit,
        reason: req.body.reason ?? null,
      },
      clientMeta(req),
    );
    let reconciliation: { jobId: string | null; preview: unknown } | null = null;
    if (req.body.reconcile !== false) {
      reconciliation = await planService.reconcileAfterQuotaChange(ctx.familyId, user.id, clientMeta(req));
    }
    res.json({ before, after, reconciliation });
  }),
);
