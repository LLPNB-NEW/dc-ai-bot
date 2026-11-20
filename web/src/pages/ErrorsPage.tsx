import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  PG_ERRORS_LIMIT,
  describePgErrorsError,
  fetchPgErrors,
  type PgErrorEntry,
  type PgErrorFeed,
} from '../api';

// 5 秒一次：报错不常有，比实时日志慢得多也不会漏；切到后台或按了暂停就停手。
const POLL_INTERVAL_MS = 5000;
const COPIED_HINT_MS = 2500;

// 501 = 后台没配中继（这一页没有数据源），502 = 中继本身取不到；两者给出的下一步不一样。
type FailureKind = 'unavailable' | 'upstream' | 'other';

interface Failure {
  kind: FailureKind;
  message: string;
}

function classifyFailure(error: unknown): FailureKind {
  if (error instanceof ApiError) {
    if (error.code === 'PG_ERRORS_UNAVAILABLE' || error.status === 501) return 'unavailable';
    if (error.code === 'PG_ERRORS_UPSTREAM' || error.status === 502) return 'upstream';
  }
  return 'other';
}

// 只到秒：毫秒对排查没意义，还会把「时间」这一列撑宽。
function formatAt(at: string): string {
  if (at === '') return '未知时间';
  const value = new Date(at);
  if (Number.isNaN(value.getTime())) return at;
  return value.toLocaleString('zh-CN', { hour12: false });
}

// 中继的耗时是毫秒：小数量保留毫秒，跨秒的换成秒，0.003s 这种读法没人要。
function formatDuration(durationMs?: number): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return '—';
  if (durationMs < 1000) return String(Math.round(durationMs)) + 'ms';
  return (durationMs / 1000).toFixed(1) + 's';
}

function orDash(value?: string): string {
  return value === undefined || value === '' ? '—' : value;
}

// 中继是同一个 key 顺序写、页面每 5 秒整份换新，at + code 已经能分开相邻两条。
function rowKey(item: PgErrorEntry, index: number): string {
  return item.at + '#' + String(index) + '#' + item.code;
}

// 复制成一段能直接贴进群里的纯文本：字段名用中文，对面不用猜哪个数字是耗时。
function entryToText(item: PgErrorEntry): string {
  const lines = [
    '时间：' + formatAt(item.at),
    '错误码：' + (item.status > 0 ? String(item.status) + ' ' : '') + item.code,
    '模型：' + orDash(item.model),
    'Key：' + orDash(item.key),
    '耗时：' + formatDuration(item.durationMs),
    '原因：' + (item.message === '' ? '（中继没给原因）' : item.message),
  ];
  if (item.requestId !== undefined) lines.push('请求：' + item.requestId);
  return lines.join('\n');
}

function feedToText(feed: PgErrorFeed): string {
  if (feed.items.length === 0) return '最近没有报错（共 0 条，累计已丢弃 ' + String(feed.dropped) + ' 条）。';
  const header = '最近 ' + String(feed.items.length) + ' 条报错（累计已丢弃 ' + String(feed.dropped) + ' 条）';
  const body = feed.items.map(
    (item, index) => String(index + 1) + '. ' + entryToText(item).split('\n').join('\n   '),
  );
  return header + '\n\n' + body.join('\n\n');
}

// 后台常在内网 http 下打开，navigator.clipboard 只在安全上下文里有，所以留一条 execCommand 的老路。
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 没有 clipboard（内网 http）或用户拒了权限，落到下面那条老路上再试一次。
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', 'readonly');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(area);
  return copied;
}

export default function ErrorsPage() {
  const [feed, setFeed] = useState<PgErrorFeed | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // 首屏那一次还没回来时显示「正在读取」，否则会先闪一张空表再变满，看着像丢数据。
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [notice, setNotice] = useState('');
  const [copiedKey, setCopiedKey] = useState('');
  const inflightRef = useRef(false);
  const hintTimerRef = useRef(0);

  // silent = 轮询触发的那一次：成功不抖、失败也不清掉手上这张表，页面不会每 5 秒闪一次白。
  async function load(silent: boolean): Promise<void> {
    if (inflightRef.current) return; // 轮询与手动刷新撞在一起时只发一次，后来的那次直接让位。
    inflightRef.current = true;
    if (!silent) setBusy(true);
    try {
      const next = await fetchPgErrors(PG_ERRORS_LIMIT);
      setFeed(next);
      setFailure(null);
    } catch (err) {
      setFailure({ kind: classifyFailure(err), message: describePgErrorsError(err) });
    } finally {
      inflightRef.current = false;
      setLoaded(true);
      if (!silent) setBusy(false);
    }
  }

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    if (paused) return undefined;
    void loadRef.current(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void loadRef.current(true);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [paused]);

  useEffect(() => () => window.clearTimeout(hintTimerRef.current), []);

  // 一句「已复制」两秒半后自己消失；同一时刻只留一条提示，免得两行字互相盖。
  function resetLater(action: () => void): void {
    window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(action, COPIED_HINT_MS);
  }

  function flashNotice(text: string): void {
    setNotice(text);
    resetLater(() => setNotice(''));
  }

  async function copyOne(item: PgErrorEntry, key: string): Promise<void> {
    if (await copyText(entryToText(item))) {
      setCopiedKey(key);
      resetLater(() => setCopiedKey(''));
      return;
    }
    flashNotice('复制失败：浏览器不让写剪贴板，请手动选中文字复制');
  }

  async function copyAll(): Promise<void> {
    if (feed === null) return;
    if (await copyText(feedToText(feed))) {
      flashNotice('已复制全部 ' + String(feed.items.length) + ' 条报错');
      return;
    }
    flashNotice('复制失败：浏览器不让写剪贴板，请手动选中文字复制');
  }

  const items = feed === null ? [] : feed.items;
  const dropped = feed === null ? 0 : feed.dropped;
  const limit = feed === null ? PG_ERRORS_LIMIT : feed.limit;
  const firstLoad = !loaded;

  return (
    <div className="page errors">
      <section className="card">
        <div className="errors-head">
          <h2>故障（PG 中继最近的报错）</h2>
          <span className={paused ? 'badge' : 'badge ok-badge'}>
            {paused ? '已暂停自动刷新' : '每 ' + String(POLL_INTERVAL_MS / 1000) + ' 秒自动刷新'}
          </span>
        </div>
        <p className="hint">
          数据来自中继的 GET /admin/errors：只记时间、错误码、模型、掩码后的 key、耗时和原因，不记 prompt 正文与图片。
        </p>
        <p className="hint">
          中继没配（缺 PG_ERRORS_URL / PG_ERRORS_TOKEN）或暂时取不到时，只有这一页给提示，别的页面与健康检查照常。
        </p>
        <div className="errors-toolbar">
          <button type="button" className="primary" disabled={busy} onClick={() => void load(false)}>
            {busy ? '刷新中…' : '刷新'}
          </button>
          <button type="button" className="ghost" onClick={() => setPaused(!paused)}>
            {paused ? '继续自动刷新' : '暂停自动刷新'}
          </button>
          <button type="button" className="ghost" disabled={items.length === 0} onClick={() => void copyAll()}>
            复制全部
          </button>
          <span className="errors-summary">
            共 {String(items.length)} 条（已丢弃 {String(dropped)} 条）
          </span>
        </div>
        {notice === '' ? null : <p className="ok">{notice}</p>}
        {failure === null ? null : (
          <div className="errors-alert">
            <p className="error">{failure.message}</p>
            <p className="hint">
              {failure.kind === 'unavailable'
                ? '补上环境变量 PG_ERRORS_URL 与 PG_ERRORS_TOKEN 再重启后台，本页就会自己恢复。'
                : failure.kind === 'upstream'
                  ? '中继没回 200：可能是地址写错、中继还没起来，或它返回的形状不对。'
                  : '可以先点「重试」；一直失败就看实时日志里的 admin / gateway 记录。'}
            </p>
            <div className="actions">
              <button type="button" className="primary" disabled={busy} onClick={() => void load(false)}>
                重试
              </button>
            </div>
          </div>
        )}
        {firstLoad ? (
          <p className="hint">正在读取中继报错…</p>
        ) : items.length === 0 ? (
          <div className="errors-empty">
            {failure === null
              ? '最近没有报错——没有报错就是好事，说明中继这条链路是通的。'
              : '还没成功取到过数据：按上面的提示处理完再点「重试」。'}
          </div>
        ) : (
          <>
            {failure === null ? null : <p className="hint">下表是上次成功拉到的数据，本次刷新失败不影响它。</p>}
            <div className="errors-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>错误码</th>
                    <th>模型</th>
                    <th>key</th>
                    <th>耗时</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const key = rowKey(item, index);
                    return (
                      <tr key={key}>
                        <td className="errors-time">{formatAt(item.at)}</td>
                        <td className="errors-code">
                          {item.status > 0 ? <span className="errors-status">{String(item.status)}</span> : null}
                          <span className="errors-code-text">{item.code}</span>
                        </td>
                        <td className="errors-model">{orDash(item.model)}</td>
                        <td className="errors-key">{orDash(item.key)}</td>
                        <td className="errors-duration">{formatDuration(item.durationMs)}</td>
                        <td className="errors-message">
                          <button type="button" className="small" onClick={() => void copyOne(item, key)}>
                            {copiedKey === key ? '已复制' : '复制'}
                          </button>
                          <span className="errors-text">
                            {item.message === '' ? '（中继没给原因）' : item.message}
                          </span>
                          {item.requestId === undefined ? null : (
                            <span className="errors-request">请求 {item.requestId}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="hint">
              最多显示最近 {String(limit)} 条，新的在最上面；「已丢弃」是中继启动以来被挤掉的总条数。
            </p>
          </>
        )}
      </section>
    </div>
  );
}
