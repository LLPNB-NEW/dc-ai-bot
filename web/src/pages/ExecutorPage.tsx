import { useEffect, useState } from 'react';
import {
  describeExecutorError,
  fetchExecutor,
  runExecutorRefresh,
  saveExecutorConfig,
  type ExecutorHealth,
  type ExecutorRequest,
  type ExecutorRun,
  type ExecutorSnapshot,
  type ExecutorStatus,
} from '../api';

// 宿主每分钟 tick 一次；5 秒轮询足够让「已开始 / 已完成」在一分钟内落到屏幕上。
const POLL_INTERVAL_MS = 5000;

type BadgeKind = 'idle' | 'paused' | 'queued' | 'running' | 'done' | 'failed';

const BADGE_CLASSES: Record<BadgeKind, string> = {
  idle: 'badge',
  paused: 'badge warn-badge',
  queued: 'badge warn-badge',
  running: 'badge accent-badge',
  done: 'badge ok-badge',
  failed: 'badge danger-badge',
};

interface Badge {
  kind: BadgeKind;
  label: string;
}

// 徽标只回答「现在在干什么」：刷新中优先于排队，排队优先于上次结果，最后才看定时是否暂停。
function describeBadge(
  config: ExecutorSnapshot['config'] | null,
  request: ExecutorRequest | null,
  status: ExecutorStatus | null,
): Badge {
  if (status !== null && status.phase === 'running') return { kind: 'running', label: '正在刷新' };
  if (request !== null) return { kind: 'queued', label: '排队中' };
  if (status !== null && status.last !== undefined) {
    if (status.last.ok === true) return { kind: 'done', label: '上次成功' };
    if (status.last.ok === false) return { kind: 'failed', label: '上次失败' };
  }
  if (config !== null && !config.enabled) return { kind: 'paused', label: '定时已暂停' };
  return { kind: 'idle', label: '空闲' };
}

function formatMoment(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  return value.toLocaleString('zh-CN', { hour12: false }) + ' · UTC ' + value.toISOString().slice(0, 19) + 'Z';
}

function formatDuration(ms: number): string {
  return ms < 1000 ? String(ms) + ' 毫秒' : (ms / 1000).toFixed(1) + ' 秒';
}

function describeSource(source: ExecutorRun['source']): string {
  return source === 'manual' ? '手动' : '定时';
}

function describeHealth(health: ExecutorHealth): string {
  const parts: string[] = [health.ok ? '可用' : '不可用'];
  if (health.pending !== null) parts.push('排队 ' + String(health.pending));
  if (health.connectedSeconds !== undefined) parts.push('已连接 ' + String(health.connectedSeconds) + ' 秒');
  if (health.requestsServed !== undefined) parts.push('服务 ' + String(health.requestsServed) + ' 次');
  if (health.requestsFailed !== undefined) parts.push('失败 ' + String(health.requestsFailed) + ' 次');
  return health.summary === undefined ? parts.join(' · ') : health.summary;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row backup-row">
      <span className="backup-label">{label}</span>
      <span className="backup-value">{value}</span>
    </div>
  );
}

function RunRows({ run, prefix }: { run: ExecutorRun; prefix: string }) {
  return (
    <>
      <InfoRow label={prefix + '来源'} value={describeSource(run.source)} />
      <InfoRow label={prefix + '开始'} value={formatMoment(run.startedAt)} />
      {run.finishedAt === undefined ? null : <InfoRow label={prefix + '结束'} value={formatMoment(run.finishedAt)} />}
      {run.durationMs === undefined ? null : <InfoRow label={prefix + '耗时'} value={formatDuration(run.durationMs)} />}
      {run.before === undefined ? null : <InfoRow label={prefix + '刷新前'} value={describeHealth(run.before)} />}
      {run.after === undefined ? null : <InfoRow label={prefix + '刷新后'} value={describeHealth(run.after)} />}
    </>
  );
}

export default function ExecutorPage() {
  const [snapshot, setSnapshot] = useState<ExecutorSnapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState('30');

  useEffect(() => {
    let disposed = false;
    let first = true;

    const load = async (): Promise<void> => {
      try {
        const next = await fetchExecutor();
        if (disposed) return;
        setSnapshot(next);
        setLoadError('');
        // 只把首次读到的配置灌进表单：之后用户正在编辑的值不能被轮询覆盖。
        if (first) {
          first = false;
          setEnabled(next.config.enabled);
          setIntervalMinutes(String(next.config.intervalMinutes));
        }
      } catch (err) {
        if (!disposed) setLoadError(describeExecutorError(err));
      }
    };

    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const config = snapshot === null ? null : snapshot.config;
  const request = snapshot === null ? null : snapshot.request;
  const status = snapshot === null ? null : snapshot.status;
  const badge = describeBadge(config, request, status);
  const current = status === null ? null : status.current;
  const last = status === null ? null : status.last;

  async function handleSave(): Promise<void> {
    const minutes = Number(intervalMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      setActionError('刷新间隔必须是 1–1440 之间的整数分钟');
      return;
    }
    setSaving(true);
    setNotice('');
    setActionError('');
    try {
      const saved = await saveExecutorConfig({ enabled, intervalMinutes: minutes });
      setSnapshot((previous) => (previous === null ? previous : { ...previous, config: saved }));
      setEnabled(saved.enabled);
      setIntervalMinutes(String(saved.intervalMinutes));
      setNotice('已保存；宿主下一次检查（最长 60 秒）后生效');
    } catch (err) {
      setActionError(describeExecutorError(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleRefresh(): Promise<void> {
    setRefreshing(true);
    setNotice('');
    setActionError('');
    try {
      const created = await runExecutorRefresh();
      // 立刻把请求挂进快照：用户不必等下一次 5 秒轮询才看到「排队中」。
      setSnapshot((previous) => (previous === null ? previous : { ...previous, request: created }));
      setNotice('已提交刷新请求，宿主最多 1 分钟内开始执行');
    } catch (err) {
      setActionError(describeExecutorError(err));
    } finally {
      setRefreshing(false);
    }
  }

  function handleReset(): void {
    setEnabled(true);
    setIntervalMinutes('30');
    setNotice('已填入默认值（启用、每 30 分钟），点保存后生效');
  }

  return (
    <div className="page executor">
      <section className="card">
        <div className="backup-head">
          <h2>执行器</h2>
          <span className={BADGE_CLASSES[badge.kind]}>{badge.label}</span>
        </div>
        <p className="hint">
          这里控制服务器上的 AI Studio 浏览器执行器。后台只写数据目录里的 JSON 文件，宿主每分钟检查一次；刷新需要重新打开页面并注入脚本，通常十几秒完成。
        </p>
        {loadError === '' ? null : <p className="error">执行器状态读取失败：{loadError}</p>}

        <div className="row executor-form">
          <label className="field">
            <span>定时刷新</span>
            <select value={enabled ? 'on' : 'off'} disabled={saving} onChange={(e) => setEnabled(e.target.value === 'on')}>
              <option value="on">启用</option>
              <option value="off">暂停</option>
            </select>
          </label>
          <label className="field">
            <span>间隔（分钟）</span>
            <input
              type="number"
              min={1}
              max={1440}
              step={1}
              value={intervalMinutes}
              disabled={saving}
              onChange={(e) => setIntervalMinutes(e.target.value)}
            />
          </label>
        </div>
        <div className="actions executor-actions">
          <button type="button" className="primary" disabled={saving} onClick={() => void handleSave()}>
            {saving ? '保存中…' : '保存设置'}
          </button>
          <button type="button" className="ghost" disabled={saving} onClick={handleReset}>
            恢复默认
          </button>
          <button
            type="button"
            className="ghost"
            disabled={refreshing || request !== null || (status !== null && status.phase === 'running')}
            onClick={() => void handleRefresh()}
          >
            {refreshing ? '提交中…' : '立即刷新'}
          </button>
        </div>
        {actionError === '' ? null : <p className="error">{actionError}</p>}
        {notice === '' ? null : <p className="ok">{notice}</p>}
        <p className="hint">
          暂停只停自动刷新；「立即刷新」仍可用。配置和请求文件都在数据目录，宿主脚本每 60 秒最多处理一次。
        </p>
      </section>

      <section className="card">
        <h2>最近状态</h2>
        {snapshot === null ? (
          <p className="hint">正在读取执行器状态…</p>
        ) : (
          <>
            <InfoRow label="上次检查" value={formatMoment(status === null ? '' : status.checkedAt)} />
            <InfoRow
              label="下次到期"
              value={
                status !== null && status.nextDueAt !== undefined
                  ? formatMoment(status.nextDueAt)
                  : config !== null && config.enabled
                    ? '等待宿主下一次检查'
                    : '定时刷新已暂停'
              }
            />
            {request === null ? null : (
              <InfoRow label="排队请求" value={formatMoment(request.requestedAt) + ' · 等待宿主领取'} />
            )}
            {current === undefined || current === null ? null : (
              <>
                <InfoRow label="正在执行" value={describeSource(current.source) + '刷新'} />
                <InfoRow label="开始时间" value={formatMoment(current.startedAt)} />
              </>
            )}
            {last === undefined || last === null ? (
              <p className="hint">还没有刷新记录。</p>
            ) : (
              <>
                <InfoRow label="上次结果" value={last.ok === true ? '成功' : last.ok === false ? '失败' : '结果未知'} />
                <RunRows run={last} prefix="" />
                {last.message === undefined ? null : <InfoRow label="结果说明" value={last.message} />}
                {last.ok === false ? <p className="error backup-failure">上次刷新失败：{last.after?.summary ?? last.message ?? '未返回原因'}</p> : null}
              </>
            )}
          </>
        )}
        <p className="hint">
          刷新会先检查 pg-relay 的 pending；有请求正在生成时本轮会自动跳过，避免把正在执行的对话打断。
        </p>
      </section>
    </div>
  );
}
