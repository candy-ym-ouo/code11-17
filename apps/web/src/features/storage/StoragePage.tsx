import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, EmptyState, Field, Spinner, Tag, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { MEDIA_KIND_LABELS } from '../../lib/constants';
import { formatBytes, formatDateTime } from '../../lib/format';
import type {
  CleanupDetail,
  CleanupPreview,
  CleanupRunSummary,
  MediaKind,
  StorageOverview,
  StoragePolicy,
} from '../../api/types';

const KIND_ORDER: MediaKind[] = ['image', 'audio', 'document'];

function daysLabel(n: number | null): string {
  return n === null ? '永不' : `${n} 天`;
}

/** 配额用量条。 */
function UsageBar({ overview }: { overview: StorageOverview }) {
  const { quota, usage, state } = overview;
  const ratio = quota.quotaBytes ? Math.min(1.2, usage.physicalBytes / quota.quotaBytes) : 0;
  const pct = Math.round(ratio * 100);
  const color = state === 'over' ? '#c0392b' : state === 'warning' ? '#d68910' : '#2e7d32';
  return (
    <div>
      <div className="row row--between" style={{ marginBottom: 6 }}>
        <strong>{formatBytes(usage.physicalBytes)}</strong>
        <span className="muted">
          {quota.quotaBytes ? `配额 ${formatBytes(quota.quotaBytes)}（${pct}%）` : '未设置配额（不限制）'}
          {quota.isDefault ? ' · 系统默认' : ''}
        </span>
      </div>
      {quota.quotaBytes ? (
        <div style={{ height: 10, borderRadius: 6, background: 'var(--surface-2)', overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: color, transition: 'width .3s' }} />
        </div>
      ) : null}
      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {state === 'over' ? <Tag tone="warn">已超限：新上传会被拒绝</Tag> : null}
        {state === 'warning' ? <Tag tone="warn">接近配额上限</Tag> : null}
        <Tag tone="muted">{usage.mediaCount} 个媒体引用</Tag>
        <Tag tone="muted">配额占用（去重后）{formatBytes(usage.physicalBytes)}</Tag>
        <Tag tone="muted">引用合计 {formatBytes(usage.logicalBytes)}</Tag>
        {usage.trashCount > 0 ? <Tag tone="muted">回收站（不计配额）{formatBytes(usage.trashBytes)}</Tag> : null}
        <Tag tone="muted">冷层 {formatBytes(usage.bytesByTier.cold ?? 0)}</Tag>
      </div>
    </div>
  );
}

function PolicyEditor({ policies, fid }: { policies: StoragePolicy[]; fid: string }) {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<StoragePolicy[]>(policies);

  useEffect(() => setDrafts(policies), [policies]);

  const update = (kind: MediaKind, patch: Partial<StoragePolicy>) =>
    setDrafts((list) => list.map((p) => (p.kind === kind ? { ...p, ...patch } : p)));

  const save = useMutation({
    mutationFn: () =>
      api.put(`/families/${fid}/storage/policies`, {
        policies: drafts.map((p) => ({
          kind: p.kind,
          hotDays: p.hotDays,
          maxAgeDays: p.maxAgeDays,
          onlyArchived: p.onlyArchived,
          enabled: p.enabled,
        })),
      }),
    onSuccess: async () => {
      push('保留策略已保存，立即生效', 'success');
      await queryClient.invalidateQueries({ queryKey: ['storage-policies', fid] });
    },
    onError: (e) => push(e instanceof ApiError ? e.message : '保存失败', 'error'),
  });

  return (
    <div className="stack" style={{ gap: 'var(--space-3)' }}>
      {drafts.map((p) => (
        <div key={p.kind} className="card" style={{ background: 'var(--surface-2)', margin: 0 }}>
          <div className="row row--between" style={{ marginBottom: 8 }}>
            <strong>{MEDIA_KIND_LABELS[p.kind]}</strong>
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={p.enabled} onChange={(e) => update(p.kind, { enabled: e.target.checked })} />
              <span>启用策略</span>
            </label>
          </div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Field label="热层保留天数（空=永不降冷）">
              <TextInput
                type="number"
                style={{ width: 180 }}
                value={p.hotDays ?? ''}
                placeholder="永不降冷"
                disabled={!p.enabled}
                onChange={(e) => update(p.kind, { hotDays: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
            <Field label="总保留天数（空=永久保留）">
              <TextInput
                type="number"
                style={{ width: 180 }}
                value={p.maxAgeDays ?? ''}
                placeholder="永久保留"
                disabled={!p.enabled}
                onChange={(e) => update(p.kind, { maxAgeDays: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
          </div>
          <label className="row" style={{ gap: 6, marginTop: 6 }}>
            <input
              type="checkbox"
              checked={p.onlyArchived}
              disabled={!p.enabled}
              onChange={(e) => update(p.kind, { onlyArchived: e.target.checked })}
            />
            <span>仅处理已归档条目（推荐：未归档的条目仍在日常使用，不会被动）</span>
          </label>
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            到期行为：{p.enabled ? `${daysLabel(p.hotDays)}后降冷；${daysLabel(p.maxAgeDays)}后删除` : '未启用，全部留在热层'}
          </p>
        </div>
      ))}
      <div>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          保存保留策略
        </Button>
      </div>
    </div>
  );
}

function QuotaEditor({ overview, fid }: { overview: StorageOverview; fid: string }) {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [gb, setGb] = useState<string>(overview.quota.quotaBytes ? String(+(overview.quota.quotaBytes / 1024 ** 3).toFixed(2)) : '');

  useEffect(() => {
    setGb(overview.quota.quotaBytes ? String(+(overview.quota.quotaBytes / 1024 ** 3).toFixed(2)) : '');
  }, [overview.quota.quotaBytes]);

  const save = useMutation({
    mutationFn: () => api.put(`/families/${fid}/storage/quota`, { quotaGb: gb === '' ? null : Number(gb) }),
    onSuccess: async () => {
      push('配额已更新，对下一次上传立即生效', 'success');
      await queryClient.invalidateQueries({ queryKey: ['storage-overview', fid] });
    },
    onError: (e) => push(e instanceof ApiError ? e.message : '保存失败', 'error'),
  });

  return (
    <div>
      <UsageBar overview={overview} />
      <div className="row" style={{ gap: 10, marginTop: 14, alignItems: 'flex-end' }}>
        <Field label="配额（GB，留空表示不限制）">
          <TextInput type="number" style={{ width: 200 }} value={gb} min={0} onChange={(e) => setGb(e.target.value)} />
        </Field>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          更新配额
        </Button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        调小到当前用量以下不会删除已有文件，但会立刻阻止新上传，直到用量回落到配额内。
      </p>
    </div>
  );
}

const STATUS_TAG: Record<string, { label: string; tone?: 'default' | 'warn' | 'success' | 'muted' }> = {
  preview: { label: '待确认', tone: 'warn' },
  approved: { label: '执行中', tone: 'default' },
  canceled: { label: '已取消', tone: 'muted' },
  expired: { label: '已过期', tone: 'muted' },
  done: { label: '已完成', tone: 'success' },
};

function PreviewPanel({ fid }: { fid: string }) {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [kinds, setKinds] = useState<MediaKind[]>(KIND_ORDER);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const toggleKind = (k: MediaKind) => setKinds((list) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]));

  const runPreview = useMutation({
    mutationFn: () =>
      api.post<CleanupPreview>(`/families/${fid}/storage/cleanups/preview`, {
        kinds,
        note: note.trim() || null,
      }),
    onSuccess: (data) => {
      setPreview(data);
      setDetailId(null);
      push(
        data.run.totalFiles === 0
          ? '预演完成：当前没有符合策略的媒体'
          : `预演完成：将影响 ${data.run.totalFiles} 个媒体引用，请确认影响面后再执行`,
        data.run.totalFiles === 0 ? 'success' : 'info',
      );
      void queryClient.invalidateQueries({ queryKey: ['cleanups', fid] });
    },
    onError: (e) => push(e instanceof ApiError ? e.message : '预演失败', 'error'),
  });

  const approve = useMutation({
    mutationFn: (runId: string) => api.post(`/families/${fid}/storage/cleanups/${runId}/approve`, { confirm: '清理' }),
    onSuccess: async () => {
      push('已确认，清理任务开始执行（在后台进行，可稍后在下方查看结果）', 'success');
      setPreview(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['cleanups', fid] }),
        queryClient.invalidateQueries({ queryKey: ['storage-overview', fid] }),
      ]);
    },
    onError: (e) => push(e instanceof ApiError ? e.message : '确认失败', 'error'),
  });

  const cancel = useMutation({
    mutationFn: (runId: string) => api.post(`/families/${fid}/storage/cleanups/cancel`, { runId }),
    onSuccess: async () => {
      push('已取消该清理计划', 'success');
      setPreview(null);
      await queryClient.invalidateQueries({ queryKey: ['cleanups', fid] });
    },
    onError: (e) => push(e instanceof ApiError ? e.message : '取消失败', 'error'),
  });

  const detail = useQuery({
    queryKey: ['cleanup-detail', fid, detailId],
    queryFn: () => api.get<{ run: CleanupRunSummary; items: CleanupDetail['items'] }>(`/families/${fid}/storage/cleanups/${detailId}`),
    enabled: Boolean(detailId),
    refetchInterval: (q) => {
      const s = q.state.data?.run.status;
      return s === 'approved' ? 1500 : false;
    },
  });

  return (
    <div className="stack" style={{ gap: 'var(--space-3)' }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="只评估这些类型">
          <div className="row" style={{ gap: 8 }}>
            {KIND_ORDER.map((k) => (
              <label key={k} className="row" style={{ gap: 4 }}>
                <input type="checkbox" checked={kinds.includes(k)} onChange={() => toggleKind(k)} />
                <span>{MEDIA_KIND_LABELS[k]}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="备注（可选）">
          <TextInput value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} placeholder="例如：2026 年大清理" />
        </Field>
        <Button variant="primary" loading={runPreview.isPending} disabled={kinds.length === 0} onClick={() => runPreview.mutate()}>
          预演影响面
        </Button>
      </div>

      {preview && preview.run.totalFiles > 0 ? (
        <div className="card" style={{ background: 'var(--surface-2)', borderColor: '#d68910' }}>
          <div className="row row--between">
            <h3 style={{ margin: 0 }}>预演结果（不会立即改动任何文件）</h3>
            <Tag tone="warn">
              {preview.run.expiresAt ? `有效至 ${formatDateTime(preview.run.expiresAt)}` : ''}
            </Tag>
          </div>
          <div className="row" style={{ gap: 8, margin: '10px 0', flexWrap: 'wrap' }}>
            <Tag tone="warn">{preview.run.tierFiles} 个降冷 · {formatBytes(preview.run.tierBytes)}</Tag>
            <Tag tone="warn">{preview.run.deleteFiles} 个删除 · {formatBytes(preview.run.deleteBytes)}</Tag>
            <Tag>共 {preview.affectedKeys.length} 个内容对象（已按去重合并）</Tag>
          </div>
          <div className="log-list" style={{ maxHeight: 320, overflow: 'auto' }}>
            {preview.affectedKeys.map((k) => (
              <div key={k.storageKey} className="log-item">
                <div className="log-item__body">
                  <div className="row" style={{ gap: 6 }}>
                    <Tag tone={k.action === 'delete' ? 'warn' : 'muted'}>
                      {k.action === 'delete' ? '删除' : '降冷'}
                    </Tag>
                    <strong>{MEDIA_KIND_LABELS[k.kind]}</strong>
                    <span>{formatBytes(k.bytes)}</span>
                    <span className="muted">×{k.refCount} 处引用</span>
                  </div>
                  <div className="log-item__meta">{k.reason}</div>
                  <div className="log-item__meta">涉及条目：{k.items.map((i) => i.itemTitle).join('、')}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 10, marginTop: 12 }}>
            <Button variant="danger" loading={approve.isPending} onClick={() => approve.mutate(preview.run.id)}>
              确认按此计划执行（输入无需更改，按钮即最终确认）
            </Button>
            <Button onClick={() => cancel.mutate(preview.run.id)}>取消</Button>
          </div>
          <p className="field__error" style={{ marginTop: 8 }}>
            删除不可撤销；同一文件只要还被不在计划内的条目引用，执行时会自动跳过。
          </p>
        </div>
      ) : preview && preview.run.totalFiles === 0 ? (
        <EmptyState icon="🌤️" title="没有需要处理的媒体" description="按当前策略，所有媒体都还在保留期内。" />
      ) : null}

      <RunsHistory fid={fid} onOpen={setDetailId} activeDetailId={detailId} detailQuery={detail} />
    </div>
  );
}

function RunsHistory({
  fid,
  onOpen,
  activeDetailId,
  detailQuery,
}: {
  fid: string;
  onOpen: (id: string) => void;
  activeDetailId: string | null;
  detailQuery: ReturnType<typeof useQuery<{ run: CleanupRunSummary; items: CleanupDetail['items'] }>>;
}) {
  const runs = useQuery({
    queryKey: ['cleanups', fid],
    queryFn: () => api.get<{ runs: CleanupRunSummary[] }>(`/families/${fid}/storage/cleanups`),
  });
  const list = runs.data?.runs ?? [];

  return (
    <div>
      <h3 style={{ marginBottom: 8 }}>清理历史</h3>
      {list.length === 0 ? (
        <p className="muted">还没有预演过。</p>
      ) : (
        <div className="log-list">
          {list.map((r) => {
            const tag = STATUS_TAG[r.status] ?? { label: r.status };
            const open = activeDetailId === r.id;
            return (
              <div key={r.id} className="log-item" style={{ cursor: 'pointer' }} onClick={() => onOpen(r.id)}>
                <div className="log-item__body">
                  <div className="row" style={{ gap: 6 }}>
                    <Tag tone={tag.tone}>{tag.label}</Tag>
                    <span>{r.note || '未命名预演'}</span>
                    <span className="muted">{formatDateTime(r.createdAt)}</span>
                  </div>
                  <div className="log-item__meta">
                    降冷 {r.tierFiles}（{formatBytes(r.tierBytes)}）· 删除 {r.deleteFiles}（{formatBytes(r.deleteBytes)}）
                    {r.result?.done !== undefined
                      ? ` · 执行：成功 ${r.result.done}，跳过 ${r.result.skipped ?? 0}，失败 ${r.result.failed ?? 0}`
                      : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {activeDetailId && detailQuery.data ? (
        <div className="card" style={{ background: 'var(--surface-2)', marginTop: 10 }}>
          <strong>逐条结果</strong>
          <div className="log-list" style={{ maxHeight: 260, overflow: 'auto', marginTop: 8 }}>
            {detailQuery.data.items.map((ci) => (
              <div key={ci.id} className="log-item">
                <div className="log-item__body">
                  <div className="row" style={{ gap: 6 }}>
                    <Tag tone={ci.action === 'delete' ? 'warn' : 'muted'}>{ci.action === 'delete' ? '删除' : '降冷'}</Tag>
                    <span>{ci.originalName}</span>
                    <Tag tone={ci.state === 'done' ? 'success' : ci.state === 'skipped' ? 'muted' : ci.state === 'failed' ? 'warn' : 'default'}>
                      {ci.state}
                    </Tag>
                  </div>
                  <div className="log-item__meta">{ci.reason}</div>
                  {ci.detail ? <div className="log-item__meta">{ci.detail}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function StoragePage() {
  const { fid } = useParams<{ fid: string }>();
  const overview = useQuery({
    queryKey: ['storage-overview', fid],
    queryFn: () => api.get<StorageOverview>(`/families/${fid}/storage/overview`),
    enabled: Boolean(fid),
  });
  const policies = useQuery({
    queryKey: ['storage-policies', fid],
    queryFn: () => api.get<{ policies: StoragePolicy[] }>(`/families/${fid}/storage/policies`),
    enabled: Boolean(fid),
  });

  const orderedPolicies = useMemo(
    () => [...(policies.data?.policies ?? [])].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)),
    [policies.data],
  );

  if (overview.isLoading || policies.isLoading || !overview.data) return <Spinner />;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>存储与保留</h1>
          <p className="page-head__sub">配额即时生效；老媒体先降冷层、到期再清理。所有清理都先预演影响面，确认后才会动文件。</p>
        </div>
      </div>

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-3)' }}>空间用量与配额</h2>
        <QuotaEditor overview={overview.data} fid={fid!} />
      </section>

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-3)' }}>按媒体类型的保留策略</h2>
        <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
          计时从「最近一次上传该文件」开始；去重文件只要还被较新的条目引用就继续留在热层。删除始终需要人工预演确认，降冷可由每日任务自动执行。
        </p>
        {orderedPolicies.length ? <PolicyEditor policies={orderedPolicies} fid={fid!} /> : <Spinner />}
      </section>

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-2)' }}>清理预演与执行</h2>
        <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
          预演只计算并展示影响面，不改任何数据；计划在 {`24`} 小时内有效，过期需重新预演，避免「看的是一套、删的是另一套」。
        </p>
        <PreviewPanel fid={fid!} />
      </section>
    </div>
  );
}
