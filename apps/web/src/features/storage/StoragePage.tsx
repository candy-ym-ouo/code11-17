import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, Spinner, Tag, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../../lib/format';

// ── 接口类型（与后端 routes/storage.ts 返回结构对应） ──
interface KindPolicy {
  kind: 'image' | 'audio' | 'document';
  hotMaxIdleDays: number | null;
  coldRetentionDays: number | null;
  protected: boolean;
  updatedAt: string;
}

interface QuotaView {
  hotBytesLimit: number | null;
  totalBytesLimit: number | null;
  updatedAt: string | null;
  isDefault: boolean;
}

interface UsageData {
  hotBytes: number;
  coldBytes: number;
  totalBytes: number;
  hotFiles: number;
  coldFiles: number;
  projected: { hotBytes: number; coldBytes: number; totalBytes: number };
  quota: {
    hotBytes: number;
    hotBytesLimit: number | null;
    hotExceeded: boolean;
    totalBytes: number;
    totalBytesLimit: number | null;
    totalExceeded: boolean;
  };
  unresolvedViolations: { code: string; shortfallBytes: number }[];
  human: Record<string, string>;
}

interface PlanAction {
  id: string;
  type: 'demote' | 'unlink' | 'purge';
  reason: string;
  kind: string;
  bytes: number;
  mediaId: string;
  itemId: string;
}

interface PlanResult {
  summary: {
    demote: number;
    unlink: number;
    purge: number;
    demoteBytes: number;
    purgeReclaimBytes: number;
    affectedItems: number;
  };
  current: UsageData;
  projected: UsageData;
  actions: PlanAction[];
  unresolvedViolations: { code: string; shortfallBytes: number }[];
}

interface StoredPlan {
  id: string;
  status: 'open' | 'applied' | 'failed' | 'expired';
  trigger: string;
  createdAt: string;
  appliedAt: string | null;
}

const KIND_LABELS: Record<KindPolicy['kind'], string> = {
  image: '图片',
  audio: '录音',
  document: '文档 / PDF',
};

const fmt = (n: number) => {
  if (n === 0) return '0 B';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : '操作失败，请稍后再试';
}

export function StoragePage() {
  const { fid } = useParams<{ fid: string }>();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const base = `/families/${fid}/storage`;

  const usageQuery = useQuery({
    queryKey: ['storage-usage', fid],
    queryFn: () => api.get<{ usage: UsageData; quota: QuotaView; policies: KindPolicy[] }>(`${base}/usage`),
    enabled: Boolean(fid),
  });
  const plansQuery = useQuery({
    queryKey: ['storage-plans', fid],
    queryFn: () => api.get<{ plans: StoredPlan[] }>(`${base}/plans?limit=10`),
    enabled: Boolean(fid),
  });

  const previewMut = useMutation({
    mutationFn: () => api.get<{ plan: PlanResult }>(`${base}/plan/preview`),
  });
  const createPlanMut = useMutation({
    mutationFn: (reason: string) => api.post<{ planId: string }>(`${base}/plans`, { reason: reason || undefined }),
  });
  const applyMut = useMutation({
    mutationFn: (planId: string) => api.post(`${base}/plans/${planId}/apply`),
    onSuccess: async () => {
      push('清理已执行完成', 'success');
      setPlanId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['storage-usage', fid] }),
        queryClient.invalidateQueries({ queryKey: ['storage-plans', fid] }),
      ]);
    },
    onError: (err) => push(errorMessage(err), 'error'),
  });

  const [planId, setPlanId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  if (usageQuery.isLoading) return <Spinner />;
  const data = usageQuery.data;
  if (!data) return <div className="empty">加载失败，请刷新重试。</div>;

  const { usage, quota, policies } = data;
  const preview = previewMut.data?.plan ?? null;

  const runPreviewThenCreate = async () => {
    const { plan } = await previewMut.mutateAsync();
    if (plan.actions.length === 0) {
      push('当前没有需要降冷或清理的内容', 'success');
      return;
    }
    const res = await createPlanMut.mutateAsync(reason);
    setPlanId(res.planId);
    push('已生成预演单，确认影响面后执行', 'success');
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>存储管理</h1>
          <p className="page-head__sub">
            按媒体类型设置冷热分层与保留策略。任何清理都会先给出预演（影响面清单），确认后才会动手。
          </p>
        </div>
      </div>

      {/* 用量与配额 */}
      <section className="card stack" style={{ gap: 'var(--space-3)' }}>
        <h2 style={{ margin: 0 }}>容量</h2>
        <QuotaBar
          label="热层（随时可看可听）"
          used={usage.hotBytes}
          limit={usage.quota.hotBytesLimit}
          exceeded={usage.quota.hotExceeded}
        />
        <QuotaBar
          label="冷层（归档，首次读取自动回暖）"
          used={usage.coldBytes}
          limit={null}
          exceeded={false}
        />
        <QuotaBar
          label="总用量"
          used={usage.totalBytes}
          limit={usage.quota.totalBytesLimit}
          exceeded={usage.quota.totalExceeded}
        />
        {usage.unresolvedViolations.length > 0 && (
          <div className="banner banner--warn">
            存在自动分层无法消除的超支（{usage.unresolvedViolations.map((v) => `${v.code} 差 ${fmt(v.shortfallBytes)}`).join('；')}），
            需要人工降冷受保护内容或调高配额。
          </div>
        )}
        <QuotaForm
          key={`${quota.hotBytesLimit}-${quota.totalBytesLimit}-${quota.updatedAt ?? 'def'}`}
          quota={quota}
          base={base}
          fid={fid!}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['storage-usage', fid] })}
          pushToast={push}
        />
      </section>

      {/* 保留策略 */}
      <section className="card stack" style={{ gap: 'var(--space-3)' }}>
        <h2 style={{ margin: 0 }}>按媒体类型的保留策略</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          「闲置降冷」=热层原片多少天没被读取就移到冷层；「回收站保留」=删除后多少天才彻底销毁；
          「受保护」的类型永不自动移动或删除（适合票据、手稿）。改动保存后即时生效。
        </p>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>闲置降冷（天，空=不自动）</th>
                <th>回收站保留（天，空=永久）</th>
                <th>受保护</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <PolicyRow key={p.kind} policy={p} base={base} fid={fid!}
                  onDone={() => queryClient.invalidateQueries({ queryKey: ['storage-usage', fid] })}
                  pushToast={push}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 预演与执行 */}
      <section className="card stack" style={{ gap: 'var(--space-3)' }}>
        <h2 style={{ margin: 0 }}>清理预演</h2>
        <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button onClick={() => previewMut.mutate()} loading={previewMut.isPending}>
            重新预演
          </Button>
          {preview && (
            <div style={{ flex: 1, minWidth: 200 }}>
              <Field label="备注（可选，会记入审计）">
                <TextInput value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="例如：升级硬盘前例行清理" />
              </Field>
            </div>
          )}
          {preview && preview.actions.length > 0 && (
            <Button variant="primary" loading={createPlanMut.isPending} onClick={() => void runPreviewThenCreate()}>
              生成预演单
            </Button>
          )}
          {planId && (
            <Button
              variant="danger"
              loading={applyMut.isPending}
              onClick={() => {
                if (window.confirm('确认按这张预演单执行？执行前服务端会再次校验每个文件的当前状态。')) {
                  void applyMut.mutate(planId);
                }
              }}
            >
              执行预演单
            </Button>
          )}
        </div>

        {preview && <PreviewPanel plan={preview} />}
      </section>

      {/* 历史预演单 */}
      <section className="card stack" style={{ gap: 'var(--space-2)' }}>
        <h2 style={{ margin: 0 }}>最近预演单</h2>
        {plansQuery.isLoading ? (
          <Spinner />
        ) : (plansQuery.data?.plans ?? []).length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>还没有预演单。</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>触发方式</th>
                  <th>状态</th>
                  <th>执行时间</th>
                </tr>
              </thead>
              <tbody>
                {(plansQuery.data?.plans ?? []).map((p) => (
                  <tr key={p.id}>
                    <td>{formatDateTime(p.createdAt)}</td>
                    <td>{p.trigger}</td>
                    <td>
                      <Tag tone={p.status === 'applied' ? 'success' : p.status === 'failed' ? 'warn' : 'default'}>
                        {p.status}
                      </Tag>
                    </td>
                    <td>{p.appliedAt ? formatDateTime(p.appliedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function QuotaBar({ label, used, limit, exceeded }: { label: string; used: number; limit: number | null; exceeded: boolean }) {
  const pct = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>{label}</span>
        <strong>
          {fmt(used)}
          {limit !== null ? ` / ${fmt(limit)}` : '（不限）'}
        </strong>
      </div>
      <div className="meter" style={{ marginTop: 4 }}>
        <div
          className={`meter__bar ${exceeded ? 'meter__bar--over' : ''}`}
          style={{ width: `${limit ? pct : Math.min(100, used / Math.max(1, 1024 ** 3))}%` }}
        />
      </div>
    </div>
  );
}

function QuotaForm({
  quota,
  base,
  fid,
  onDone,
  pushToast,
}: {
  quota: QuotaView;
  base: string;
  fid: string;
  onDone: () => void;
  pushToast: ReturnType<typeof useToast>['push'];
}) {
  const [hot, setHot] = useState(quota.hotBytesLimit !== null ? fmt(quota.hotBytesLimit).replace(' ', '') : '');
  const [total, setTotal] = useState(
    quota.totalBytesLimit !== null ? fmt(quota.totalBytesLimit).replace(' ', '') : '',
  );
  const mut = useMutation({
    mutationFn: () =>
      api.put(`${base}/quota`, {
        hotBytesLimit: hot.trim() === '' ? null : parseHuman(hot),
        totalBytesLimit: total.trim() === '' ? null : parseHuman(total),
        reason: '管理页修改',
      }),
    onSuccess: () => {
      pushToast('配额已更新，后台正在自动收敛热层', 'success');
      onDone();
    },
    onError: (err) => pushToast(errorMessage(err), 'error'),
  });
  void fid;

  return (
    <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <Field label="热层配额（如 20GiB，空=不限）">
        <TextInput value={hot} onChange={(e) => setHot(e.target.value)} placeholder="不限" style={{ width: 180 }} />
      </Field>
      <Field label="总配额（如 100GB，空=不限）">
        <TextInput value={total} onChange={(e) => setTotal(e.target.value)} placeholder="不限" style={{ width: 180 }} />
      </Field>
      <Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate()}>
        保存配额
      </Button>
    </div>
  );
}

function PolicyRow({
  policy,
  base,
  fid,
  onDone,
  pushToast,
}: {
  policy: KindPolicy;
  base: string;
  fid: string;
  onDone: () => void;
  pushToast: ReturnType<typeof useToast>['push'];
}) {
  const [hotDays, setHotDays] = useState(policy.hotMaxIdleDays?.toString() ?? '');
  const [retainDays, setRetainDays] = useState(policy.coldRetentionDays?.toString() ?? '');
  const [prot, setProt] = useState(policy.protected);

  const mut = useMutation({
    mutationFn: () =>
      api.put(`${base}/policies/${policy.kind}`, {
        hotMaxIdleDays: hotDays.trim() === '' ? null : Number(hotDays),
        coldRetentionDays: retainDays.trim() === '' ? null : Number(retainDays),
        protected: prot,
      }),
    onSuccess: () => {
      pushToast(`${KIND_LABELS[policy.kind]}策略已更新`, 'success');
      onDone();
    },
    onError: (err) => pushToast(errorMessage(err), 'error'),
  });
  void fid;

  return (
    <tr>
      <td>
        <strong>{KIND_LABELS[policy.kind]}</strong>
      </td>
      <td>
        <TextInput
          value={hotDays}
          disabled={prot}
          onChange={(e) => setHotDays(e.target.value.replace(/[^0-9]/g, ''))}
          style={{ width: 110 }}
        />
      </td>
      <td>
        <TextInput
          value={retainDays}
          disabled={prot}
          onChange={(e) => setRetainDays(e.target.value.replace(/[^0-9]/g, ''))}
          style={{ width: 110 }}
        />
      </td>
      <td>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={prot} onChange={(e) => setProt(e.target.checked)} />
          受保护
        </label>
      </td>
      <td>
        <Button loading={mut.isPending} onClick={() => mut.mutate()}>
          保存
        </Button>
      </td>
    </tr>
  );
}

function PreviewPanel({ plan }: { plan: PlanResult }) {
  if (plan.actions.length === 0) {
    return <p className="muted" style={{ margin: 0 }}>预演结果：没有需要执行的动作。</p>;
  }
  const byType = {
    demote: plan.actions.filter((a) => a.type === 'demote'),
    unlink: plan.actions.filter((a) => a.type === 'unlink'),
    purge: plan.actions.filter((a) => a.type === 'purge'),
  };
  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Tag tone="default">降冷 {plan.summary.demote} 项 · {fmt(plan.summary.demoteBytes)}</Tag>
        <Tag tone="warn">彻底删除 {plan.summary.purge} 项（仅回收站超期）</Tag>
        <Tag tone="muted">回收物理文件 {plan.summary.unlink} 组</Tag>
        <Tag tone="muted">影响条目 {plan.summary.affectedItems} 个</Tag>
      </div>
      <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>动作</th>
              <th>类型</th>
              <th>原因</th>
              <th>大小</th>
            </tr>
          </thead>
          <tbody>
            {plan.actions.slice(0, 200).map((a) => (
              <tr key={a.id}>
                <td>
                  <Tag tone={a.type === 'purge' ? 'warn' : a.type === 'demote' ? 'default' : 'muted'}>
                    {a.type === 'demote' ? '降冷' : a.type === 'purge' ? '删除' : '回收文件'}
                  </Tag>
                </td>
                <td>{KIND_LABELS[a.kind as KindPolicy['kind']] ?? a.kind}</td>
                <td className="muted">{a.reason}</td>
                <td>{a.type === 'unlink' ? '—' : fmt(a.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.actions.length > 200 && <p className="muted" style={{ margin: 0 }}>仅显示前 200 项，共 {plan.actions.length} 项。</p>}
      {byType.purge.length > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          删除项全部来自回收站且已过该类型的保留期；条目若在预演后被恢复，执行时会自动跳过。
        </p>
      )}
    </div>
  );
}

/** 把 20GiB / 1.5GB / 500 解析成字节（与后端 parseBytes 同一套口径）。 */
function parseHuman(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgtpe]?)(i?b)?$/i.exec(input.trim());
  if (!m) throw new Error('容量格式不正确');
  const v = Number(m[1]);
  const u = (m[2] ?? '').toUpperCase();
  const base = m[3] || m[2] ? 1024 : 1000;
  const powers: Record<string, number> = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
  return Math.round(v * base ** (powers[u] ?? 0));
}
