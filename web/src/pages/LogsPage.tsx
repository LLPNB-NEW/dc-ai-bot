import { useEffect, useMemo, useRef, useState } from 'react';
import { describeError, fetchLogs, type LogLevel, type StoredLogEntry } from '../api';

const PAGE_LIMIT = 200;
const POLL_INTERVAL_MS = 2000;
const MAX_LINES = 500;

type LevelFilter = 'all' | LogLevel;

const LEVEL_FILTERS: Array<{ id: LevelFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'info', label: '信息' },
  { id: 'warn', label: '警告' },
  { id: 'error', label: '错误' },
];

const LEVEL_BADGES: Record<LogLevel, string> = { info: 'INFO', warn: 'WARN', error: 'ERROR' };

function toLevelFilter(raw: string): LevelFilter {
  return raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'all';
}

function formatTime(createdAt: string): string {
  const value = new Date(createdAt);
  if (Number.isNaN(value.getTime())) return '--:--:--';
  return value.toLocaleTimeString('zh-CN', { hour12: false });
}

export default function LogsPage() {
  const [entries, setEntries] = useState<StoredLogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<LevelFilter>('all');
  const [scope, setScope] = useState('');
  const [notice, setNotice] = useState('');

  // 轮询游标：清空视图时故意保留，避免把环形表里的旧日志再拉一遍。
  const cursorRef = useRef(0);
  const inflightRef = useRef(false);
  const viewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (paused) return undefined;
    let disposed = false;
    let timer = 0;

    const poll = async (): Promise<void> => {
      if (disposed || inflightRef.current) return;
      inflightRef.current = true;
      try {
        const result = await fetchLogs(cursorRef.current, PAGE_LIMIT);
        if (disposed) return;
        const fresh: StoredLogEntry[] = [];
        let cursor = cursorRef.current;
        for (const item of result.items) {
          if (item.id > cursor) {
            fresh.push(item);
            cursor = item.id;
          }
        }
        cursorRef.current = cursor;
        if (fresh.length > 0) setEntries((prev) => prev.concat(fresh).slice(-MAX_LINES));
        setNotice('');
      } catch (err) {
        if (!disposed) setNotice('日志拉取失败：' + describeError(err));
      } finally {
        inflightRef.current = false;
      }
    };

    void poll();
    timer = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [paused]);

  useEffect(() => {
    if (paused) return;
    const view = viewRef.current;
    if (view !== null) view.scrollTop = view.scrollHeight;
  }, [entries, paused, level, scope]);

  const scopeOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const item of entries) seen.add(item.scope);
    if (scope !== '') seen.add(scope);
    return Array.from(seen).sort();
  }, [entries, scope]);

  const visible = useMemo(
    () => entries.filter((item) => (level === 'all' || item.level === level) && (scope === '' || item.scope === scope)),
    [entries, level, scope],
  );

  return (
    <div className="page logs">
      <section className="card">
        <div className="logs-head">
          <h2>实时日志</h2>
          <span className={paused ? 'badge' : 'badge ok-badge'}>{paused ? '已暂停' : '每 2 秒刷新'}</span>
        </div>
        <p className="hint">服务端只保留最近 800 条运行日志；本页最多保留 500 条，超出丢最旧。</p>
        <div className="logs-toolbar">
          <label className="field logs-filter">
            <span>级别</span>
            <select value={level} onChange={(event) => setLevel(toLevelFilter(event.target.value))}>
              {LEVEL_FILTERS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field logs-filter">
            <span>scope</span>
            <select value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="">全部</option>
              {scopeOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button type="button" className="ghost" onClick={() => setPaused(!paused)}>
              {paused ? '继续' : '暂停'}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setEntries([]);
                setNotice('');
              }}
            >
              清空视图
            </button>
          </div>
        </div>
        {notice === '' ? null : <p className="error">{notice}</p>}
        <div className="logs-view" ref={viewRef}>
          {visible.length === 0 ? (
            <p className="hint">还没有日志。</p>
          ) : (
            visible.map((item) => (
              <div className="log-line" key={item.id}>
                <span className="log-time">{formatTime(item.createdAt)}</span>
                <span className={'log-level ' + item.level}>{LEVEL_BADGES[item.level]}</span>
                <span className="log-scope">{item.scope}</span>
                <span className="log-message">{item.message}</span>
              </div>
            ))
          )}
        </div>
        <p className="hint">
          显示 {visible.length} 条 / 缓存 {entries.length} 条（上限 {MAX_LINES} 条）。
        </p>
      </section>
    </div>
  );
}
