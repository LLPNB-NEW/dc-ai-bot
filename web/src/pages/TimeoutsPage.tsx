import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  describeError,
  describeTimeoutRejection,
  fetchTimeouts,
  resetTimeouts,
  saveTimeouts,
  type TimeoutFieldView,
  type TimeoutsPayload,
} from '../api';

// 输入框里存字符串：中途会出现空串、'18'、'180000.' 这种半成品，Number() 一转就丢了光标位置。
type Draft = Record<string, string>;

function toDraft(payload: TimeoutsPayload): Draft {
  const draft: Draft = { multiplier: String(payload.multiplier.value) };
  for (const field of payload.fields) draft[field.key] = String(field.valueMs);
  return draft;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return String(Math.round(ms)) + ' 毫秒';
  const seconds = ms / 1000;
  return (Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)) + ' 秒（' + String(Math.round(ms)) + ' 毫秒）';
}

function parseDraft(draft: Draft, payload: TimeoutsPayload | null): string | null {
  if (payload === null) return '还没读到后端配置';
  for (const field of payload.fields) {
    const raw = (draft[field.key] ?? '').trim();
    if (raw === '') return '「' + field.label + '」不能留空';
    const value = Number(raw);
    if (!Number.isFinite(value)) return '「' + field.label + '」不是数字';
    if (value < field.minMs || value > field.maxMs) {
      return '「' + field.label + '」要在 ' + String(field.minMs) + '–' + String(field.maxMs) + ' 毫秒之间';
    }
  }
  const rawMultiplier = (draft.multiplier ?? '').trim();
  if (rawMultiplier === '') return '倍率不能留空';
  const multiplier = Number(rawMultiplier);
  if (!Number.isFinite(multiplier)) return '倍率不是数字';
  if (multiplier < payload.multiplier.min || multiplier > payload.multiplier.max) {
    return '倍率要在 ' + String(payload.multiplier.min) + '–' + String(payload.multiplier.max) + ' 之间';
  }
  return null;
}

function rejectText(error: unknown): string {
  // 401 已经是中文了，再加前缀反而不像后台自己的话。
  if (error instanceof ApiError && error.status === 401) return describeError(error);
  return describeTimeoutRejection(error);
}

export default function TimeoutsPage() {
  const [payload, setPayload] = useState<TimeoutsPayload | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function adopt(next: TimeoutsPayload): void {
    setPayload(next);
    setDraft(toDraft(next));
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchTimeouts()
      .then((next) => {
        if (!alive) return;
        adopt(next);
        setError('');
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(rejectText(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // 只在进页面时读一次；之后由保存/恢复的返回值回填，避免把用户正在改的值冲掉。
  }, []);

  const invalid = useMemo(() => parseDraft(draft, payload), [draft, payload]);
  const dirty = useMemo(() => {
    if (payload === null) return false;
    const baseline = toDraft(payload);
    return Object.keys(baseline).some((key) => (draft[key] ?? '') !== baseline[key]);
  }, [draft, payload]);

  function update(key: string, value: string): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice('');
  }

  async function handleSave(): Promise<void> {
    if (payload === null || invalid !== null) return;
    const values: Record<string, number> = { multiplier: Number((draft.multiplier ?? '').trim()) };
    for (const field of payload.fields) values[field.key] = Number((draft[field.key] ?? '').trim());
    setSaving(true);
    try {
      const next = await saveTimeouts(values);
      adopt(next);
      setError('');
      setNotice('已保存，下一条请求就按新值计时（不用重启）');
    } catch (cause: unknown) {
      setError(rejectText(cause));
      setNotice('');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset(): Promise<void> {
    if (payload === null) return;
    setSaving(true);
    try {
      const next = await resetTimeouts();
      adopt(next);
      setError('');
      setNotice('已恢复成 .env 与内置默认');
    } catch (cause: unknown) {
      setError(rejectText(cause));
      setNotice('');
    } finally {
      setSaving(false);
    }
  }

  const multiplier = payload?.multiplier;
  const overriddenCount = payload?.fields.filter((field) => field.overridden).length ?? 0;

  return (
    <section className="page">
      <header className="page-head">
        <h2>超时</h2>
        <p className="hint">
          每一项都可以单独改，倍率再统一乘一遍。保存后立刻生效（每次调用现取），重启不影响。<code>.env</code> 里的值只在
          这里恢复默认后才重新露出；现在有 {String(overriddenCount)} 项被后台覆盖。
        </p>
      </header>

      {loading ? <p className="hint">正在读取配置…</p> : null}
      {error !== '' ? <p className="error">{error}</p> : null}
      {notice !== '' ? <p className="hint">{notice}</p> : null}

      {payload !== null ? (
        <>
          <div className="card">
            <h3>全局倍率</h3>
            <p className="hint">
              一次性把所有超时放大或缩小，{String(multiplier?.min ?? 0.1)}–{String(multiplier?.max ?? 10)} 倍；单项还会被夹在它自己的上下限里。
            </p>
            <label className="field">
              <span>倍率</span>
              <input
                inputMode="decimal"
                value={draft.multiplier ?? ''}
                onChange={(event) => update('multiplier', event.target.value)}
              />
              <small>默认 {String(multiplier?.default ?? 1)} 倍</small>
            </label>
          </div>

          <div className="card">
            <h3>逐项</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>毫秒</th>
                  <th>生效</th>
                  <th>范围</th>
                </tr>
              </thead>
              <tbody>
                {payload.fields.map((field: TimeoutFieldView) => (
                  <tr key={field.key}>
                    <td>
                      <strong>{field.label}</strong>
                      <div className="hint">{field.detail}</div>
                      <div className="hint">
                        <code>{field.env}</code>
                        {field.overridden ? '（已被后台覆盖）' : '（默认）'}
                      </div>
                    </td>
                    <td>
                      <input
                        inputMode="numeric"
                        value={draft[field.key] ?? ''}
                        onChange={(event) => update(field.key, event.target.value)}
                      />
                      <div className="hint">默认 {String(field.defaultMs)}</div>
                    </td>
                    <td>{formatMs(field.effectiveMs)}</td>
                    <td>
                      {String(field.minMs)}–{String(field.maxMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row">
            <button type="button" onClick={() => void handleSave()} disabled={saving || invalid !== null || !dirty}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button type="button" className="ghost" onClick={() => void handleReset()} disabled={saving}>
              恢复默认
            </button>
            {invalid !== null && dirty ? <span className="hint">{invalid}</span> : null}
            {invalid === null && !dirty ? <span className="hint">没有改动</span> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
