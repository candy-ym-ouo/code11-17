import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/client';
import { mediaSrc } from '../../lib/media';
import { MEDIA_KIND_LABELS } from '../../lib/constants';
import { formatBytes } from '../../lib/format';
import type { Media } from '../../api/types';
import { Button, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';

/** 冷层媒体标记 + 一键取回（管理员/可管理者可见）。 */
function ColdBadge({ fid, media, onChange }: { fid: string; media: Media; onChange: () => void }) {
  const { push } = useToast();
  const restore = useMutation({
    mutationFn: () => api.post<{ restored: boolean; bytes: number }>(`/families/${fid}/storage/media/${media.id}/restore`, {}),
    onSuccess: (r) => {
      push(r.restored ? '已取回热层' : '文件已在热层', 'success');
      onChange();
    },
    onError: () => push('取回失败，冷盘可能未挂载', 'error'),
  });
  return (
    <span className="row" style={{ gap: 4 }}>
      <Tag tone="muted">❄️ 冷层</Tag>
      <Button size="sm" variant="ghost" loading={restore.isPending} onClick={() => restore.mutate()}>
        取回
      </Button>
    </span>
  );
}

/** 表单里的媒体清单：可以设封面、填说明、删除。 */
export function MediaStrip({
  fid,
  media,
  editable,
  onChange,
}: {
  fid: string;
  media: Media[];
  editable: boolean;
  onChange: () => void;
}) {
  const { push } = useToast();

  if (media.length === 0) {
    return <p className="muted">还没有上传任何照片或录音。先保存条目，再回到详情页上传也可以。</p>;
  }

  return (
    <div className="media-strip">
      {media.map((m) => (
        <div key={m.id} className="media-tile">
          <div className="media-tile__preview">
            {m.kind === 'image' && m.thumbUrl ? (
              <img src={mediaSrc(m.thumbUrl)} alt={m.caption || m.originalName} loading="lazy" />
            ) : (
              <span aria-hidden="true">{m.kind === 'audio' ? '🎙️' : m.kind === 'document' ? '📄' : '🖼️'}</span>
            )}
          </div>
          <div className="media-tile__body">
            <span title={m.originalName} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.caption || m.originalName}
            </span>
            <span className="muted">
              {MEDIA_KIND_LABELS[m.kind]} · {formatBytes(m.byteSize)}
            </span>
            {m.status === 'processing' ? <Tag tone="warn">处理中</Tag> : null}
            {m.status === 'failed' ? <Tag tone="warn">处理失败</Tag> : null}
            {m.tier === 'cold' ? <ColdBadge fid={fid} media={m} onChange={onChange} /> : null}
            {editable ? (
              <div className="media-tile__actions">
                {m.kind === 'image' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api.patch(`/families/${fid}/media/${m.id}`, { setCover: true });
                      push('已设为封面', 'success');
                      onChange();
                    }}
                  >
                    设封面
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api.del(`/families/${fid}/media/${m.id}`);
                    push('已删除', 'success');
                    onChange();
                  }}
                >
                  删除
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

