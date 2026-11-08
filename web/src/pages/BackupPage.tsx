import { useEffect, useState } from 'react';
import {
  describeBackupError,
  fetchBackup,
  runBackupNow,
  type BackupRequest,
  type BackupSnapshot,
  type BackupStatus,
} from '../api';

// 宿主每分钟才检查一次请求文件：3 秒一次足够让「已开跑 / 已完成」在一分钟内落到屏幕上。
const POLL_INTERVAL_MS = 3000;
const KB = 1024;
const MB = 1024 * 1024;

type BadgeKind = 'idle' | 'queued' | 'running' | 'done' | 'failed';

const BADGE_CLASSES: Record<BadgeKind, string> = {
  idle: 'badge',
  queued: 'badge warn-badge',
  running: 'badge accent-badge',
  done: 'badge ok-badge',
  failed: 'badge danger-badge',
};

interface Badge {
  kind: BadgeKind;
  label: string;
}

// 徽标只回答「现在在干什么」：跑着的备份优先于排队中的请求，其次才是上一次的成败。
function describeBadge(request: BackupRequest | null, status: BackupStatus | null): Badge {
  if (status !== null && status.phase === 'running') return { kind: 'running', label: '正在备份' };
  if (request !== null) return { kind: 'queued', label: '排队中' };
  if (status !== null && status.phase === 'done') return { kind: 'done', label: '上次成功' };
  if (status !== null && status.phase === 'failed') return { kind: 'failed', label: '上次失败' };
  return { kind: 'idle', label: '空闲' };
}

// 本地时间与 UTC 一起给：宿主按 UTC 记账，人按本地时间判断「刚点的这次跑没跑」。
function formatMoment(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  return value.toLocaleString('zh-CN', { hour12: false }) + ' · UTC ' + value.toISOString().slice(0, 19) + 'Z';
}

function formatBytes(bytes: number): string {
  return bytes < MB ? (bytes / KB).toFixed(2) + ' KB' : (bytes / MB).toFixed(2) + ' MB';
}

function describeSource(source: BackupStatus['source']): string {
  return source === 'daily' ? '每日' : '手动';
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row backup-row">
      <span className="backup-label">{label}</span>
      <span className="backup-value">{value}</span>
    </div>
  );
}

export default function BackupPage() {
  const [snapshot, setSnapshot] = useState<BackupSnapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let disposed = false;
    fetchBackup()
      .then((next) => {
        if (!disposed) setSnapshot(next);
      })
      .catch((err: unknown) => {
        if (!disposed) setLoadError(describeBackupError(err));
      });
    return () => {
      disposed = true;
    };
  }, []);

  const request = snapshot === null ? null : snapshot.request;
  const status = snapshot === null ? null : snapshot.status;
  // 只有「还在处理」才轮询：请求文件还在，或脚本已经开跑；其余状态（含干净状态）根本没有定时器。
  const polling = request !== null || (status !== null && status.phase === 'running');

  useEffect(() => {
    if (!polling) return undefined;
    let disposed = false;
    let timer = 0;
    const poll = async (): Promise<void> => {
      try {
        const next = await fetchBackup();
        if (disposed) return;
        setSnapshot(next);
        setActionError('');
      } catch (err) {
        // 轮询失败保留上一次结果，只提示一句，不把整屏拆掉。
        if (!disposed) setActionError(describeBackupError(err));
      }
    };
    timer = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [polling]);

  async function handleRun(): Promise<void> {
    setSubmitting(true);
    setNotice('');
    setActionError('');
    try {
      const created = await runBackupNow();
      // 立刻把请求挂进快照：它就是上面的轮询开关，用户不必等下一次 3 秒才看到「排队中」。
      setSnapshot({ request: created, status });
      setNotice('已提交，宿主最多 1 分钟内开始执行');
    } catch (err) {
      setActionError(describeBackupError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const badge = describeBadge(request, status);

  return (
    <div className="page backup">
      <section className="card">
        <div className="backup-head">
          <h2>备份</h2>
          <span className={BADGE_CLASSES[badge.kind]}>{badge.label}</span>
        </div>
        <p className="hint">
          后台只写一个请求文件，宿主每 1 分钟检查一次，点完最长可能等 60 秒才开始，结果也是在之后才出现。
        </p>
        {loadError === '' ? null : <p className="error">备份状态读取失败：{loadError}</p>}
        {snapshot !== null && request === null && status === null ? <p className="hint">还没有备份记录。</p> : null}
        {request === null ? null : <InfoRow label="提交时间" value={formatMoment(request.requestedAt)} />}
        {status === null ? null : <InfoRow label="开始时间" value={formatMoment(status.startedAt)} />}
        {status === null || status.finishedAt === undefined ? null : (
          <InfoRow label="结束时间" value={formatMoment(status.finishedAt)} />
        )}
        {status === null ? null : <InfoRow label="来源" value={describeSource(status.source)} />}
        {status === null || status.file === undefined ? null : (
          <div className="row backup-row">
            <span className="backup-label">文件名</span>
            <span className="backup-value backup-file">{status.file}</span>
          </div>
        )}
        {status === null || status.bytes === undefined ? null : (
          <InfoRow label="大小" value={formatBytes(status.bytes)} />
        )}
        {status === null || status.keptRemote === undefined ? null : (
          <InfoRow label="远端保留" value={String(status.keptRemote) + ' 份'} />
        )}
        {status === null || status.remote === undefined ? null : (
          <InfoRow label="远端路径" value={status.remote} />
        )}
        {status === null || status.error === undefined ? null : (
          <p className="error backup-failure">上次备份失败：{status.error}</p>
        )}
        {actionError === '' ? null : <p className="error">{actionError}</p>}
        {notice === '' ? null : <p className="ok">{notice}</p>}
        <div className="actions">
          <button type="button" className="primary" disabled={submitting || polling} onClick={() => void handleRun()}>
            {submitting ? '提交中…' : '立即备份'}
          </button>
        </div>
        <p className="hint">
          备份包含数据库一致性快照 + Caddyfile + docker-compose.yml，不含 .env；网盘目录 gdrive:dc-ai-bot-backup
          保留最近 30 份；恢复步骤见 docs/hosting.md §17.4。
        </p>
      </section>
    </div>
  );
}
