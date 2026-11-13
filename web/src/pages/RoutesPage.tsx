import { useEffect, useState } from 'react';
import {
  PROVIDER_IDS,
  api,
  describeError,
  describeScopeTarget,
  formatNumber,
  normalizeScopeId,
  parseOptionalNumber,
  type ModelRef,
  type ProviderId,
  type RouteItem,
  type Scope,
} from '../api';
import ScopeField from '../components/ScopeField';

interface FallbackRow extends ModelRef {
  rowId: number;
}

let rowSeq = 0;

function newRow(provider: ProviderId, model: string): FallbackRow {
  rowSeq += 1;
  return { rowId: rowSeq, provider, model };
}

export default function RoutesPage() {
  const [scope, setScope] = useState<Scope>('global');
  const [scopeId, setScopeId] = useState('');
  const [primaryProvider, setPrimaryProvider] = useState<ProviderId>('openai-compat');
  const [primaryModel, setPrimaryModel] = useState('');
  const [rows, setRows] = useState<FallbackRow[]>([]);
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [topP, setTopP] = useState('');
  const [topK, setTopK] = useState('');
  const [seed, setSeed] = useState('');
  const [frequencyPenalty, setFrequencyPenalty] = useState('');
  const [presencePenalty, setPresencePenalty] = useState('');
  const [items, setItems] = useState<RouteItem[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadItems();
  }, []);

  async function loadItems(): Promise<void> {
    try {
      setItems(await api.listRoutes());
    } catch (err) {
      setError(describeError(err));
    }
  }

  function currentTarget(): { scope: Scope; scopeId: string } {
    return { scope, scopeId: normalizeScopeId(scope, scopeId) };
  }

  async function save(): Promise<void> {
    if (busy) return;
    setMessage('');
    setError('');
    if (primaryModel.trim() === '') {
      setError('请填写主模型名称');
      return;
    }
    if (rows.some((row) => row.model.trim() === '')) {
      setError('备用模型名称不能为空，请填写或删除该行');
      return;
    }
    setBusy(true);
    try {
      const target = currentTarget();
      await api.saveRoute({
        scope: target.scope,
        scopeId: target.scopeId,
        primary: { provider: primaryProvider, model: primaryModel.trim() },
        fallbacks: rows.map((row) => ({ provider: row.provider, model: row.model.trim() })),
        temperature: parseOptionalNumber(temperature),
        maxTokens: parseOptionalNumber(maxTokens),
        reasoningEffort: reasoningEffort === '' ? undefined : reasoningEffort,
        topP: parseOptionalNumber(topP),
        topK: parseOptionalNumber(topK),
        seed: parseOptionalNumber(seed),
        frequencyPenalty: parseOptionalNumber(frequencyPenalty),
        presencePenalty: parseOptionalNumber(presencePenalty),
      });
      setMessage('已保存 ' + describeScopeTarget(target.scope, target.scopeId));
      await loadItems();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: { scope: Scope; scopeId: string }): Promise<void> {
    if (!window.confirm('确定删除 ' + describeScopeTarget(target.scope, target.scopeId) + ' 的路由？')) return;
    setMessage('');
    setError('');
    try {
      await api.deleteRoute(target);
      setMessage('已删除 ' + describeScopeTarget(target.scope, target.scopeId));
      await loadItems();
    } catch (err) {
      setError(describeError(err));
    }
  }

  function loadItem(item: RouteItem): void {
    setScope(item.scope);
    setScopeId(item.scope === 'global' ? '' : item.scopeId);
    setPrimaryProvider(item.primary.provider);
    setPrimaryModel(item.primary.model);
    setRows(item.fallbacks.map((fallback) => newRow(fallback.provider, fallback.model)));
    setTemperature(formatNumber(item.temperature));
    setMaxTokens(formatNumber(item.maxTokens));
    setReasoningEffort(item.reasoningEffort ?? '');
    setTopP(formatNumber(item.topP));
    setTopK(formatNumber(item.topK));
    setSeed(formatNumber(item.seed));
    setFrequencyPenalty(formatNumber(item.frequencyPenalty));
    setPresencePenalty(formatNumber(item.presencePenalty));
    setError('');
    setMessage('已载入 ' + describeScopeTarget(item.scope, item.scopeId));
  }

  function updateRow(rowId: number, patch: Partial<ModelRef>): void {
    setRows((current) =>
      current.map((row) => {
        if (row.rowId !== rowId) return row;
        return {
          rowId: row.rowId,
          provider: patch.provider ?? row.provider,
          model: patch.model ?? row.model,
        };
      }),
    );
  }

  return (
    <div className="page">
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2>模型路由</h2>
        <p className="hint">按 primary → fallbacks 顺序尝试；全部失败则报 ALL_PROVIDERS_FAILED。</p>
        <ScopeField
          scope={scope}
          scopeId={scopeId}
          onScopeChange={setScope}
          onScopeIdChange={setScopeId}
        />
        <div className="row">
          <label className="field">
            <span>主 provider</span>
            <select value={primaryProvider} onChange={(event) => setPrimaryProvider(event.target.value as ProviderId)}>
              {PROVIDER_IDS.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>主 model</span>
            <input type="text" value={primaryModel} placeholder="例如 gpt-4o-mini" onChange={(event) => setPrimaryModel(event.target.value)} />
          </label>
        </div>
        <fieldset className="fallbacks">
          <legend>备用模型（按顺序回退）</legend>
          {rows.length === 0 ? <p className="hint">没有备用模型。</p> : null}
          {rows.map((row) => (
            <div className="row fallback" key={row.rowId}>
              <select value={row.provider} onChange={(event) => updateRow(row.rowId, { provider: event.target.value as ProviderId })}>
                {PROVIDER_IDS.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={row.model}
                placeholder="model 名称"
                onChange={(event) => updateRow(row.rowId, { model: event.target.value })}
              />
              <button
                type="button"
                className="danger small"
                onClick={() => setRows((current) => current.filter((item) => item.rowId !== row.rowId))}
              >
                移除
              </button>
            </div>
          ))}
          <button
            type="button"
            className="ghost small"
            onClick={() => setRows((current) => [...current, newRow('openai-compat', '')])}
          >
            + 添加备用模型
          </button>
        </fieldset>
        <div className="row">
          <label className="field">
            <span>temperature（可选）</span>
            <input type="number" step="0.1" min="0" max="2" value={temperature} onChange={(event) => setTemperature(event.target.value)} />
          </label>
          <label className="field">
            <span>maxTokens（可选）</span>
            <input type="number" min="1" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} />
          </label>
          <label className="field">
            <span>思考强度（可选）</span>
            <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>
              <option value="">默认（不发送）</option>
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </label>
        </div>
        <p className="hint">xhigh 仅 gemini-4-hydrogen；不填时上下文工具模式仍用 low，普通模式不发送。</p>
        <div className="row">
          <label className="field">
            <span>topP（可选，0–1）</span>
            <input type="number" step="0.1" min="0" max="1" value={topP} onChange={(event) => setTopP(event.target.value)} />
          </label>
          <label className="field">
            <span>topK（可选，1–1000）</span>
            <input type="number" step="1" min="1" max="1000" value={topK} onChange={(event) => setTopK(event.target.value)} />
          </label>
          <label className="field">
            <span>seed（可选，整数）</span>
            <input type="number" step="1" min="0" value={seed} onChange={(event) => setSeed(event.target.value)} />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>frequencyPenalty（可选，-2–2）</span>
            <input type="number" step="0.1" min="-2" max="2" value={frequencyPenalty} onChange={(event) => setFrequencyPenalty(event.target.value)} />
          </label>
          <label className="field">
            <span>presencePenalty（可选，-2–2）</span>
            <input type="number" step="0.1" min="-2" max="2" value={presencePenalty} onChange={(event) => setPresencePenalty(event.target.value)} />
          </label>
        </div>
        {message === '' ? null : <p className="ok">{message}</p>}
        {error === '' ? null : <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button type="button" className="ghost" onClick={() => void remove(currentTarget())}>
            删除当前作用域
          </button>
        </div>
      </form>

      <aside className="card">
        <h2>已有路由</h2>
        {items.length === 0 ? <p className="hint">还没有配置路由。缺少路由时对话会直接报 NO_ROUTE_CONFIGURED。</p> : null}
        <ul className="items">
          {items.map((item) => (
            <li key={describeScopeTarget(item.scope, item.scopeId)}>
              <button type="button" className="link" onClick={() => loadItem(item)}>
                {describeScopeTarget(item.scope, item.scopeId)}
              </button>
              <span className="hint">
                {item.primary.provider}:{item.primary.model}
                {item.fallbacks.length === 0 ? '' : ' +' + String(item.fallbacks.length) + ' 备用'}
              </span>
              <button
                type="button"
                className="danger small"
                onClick={() => void remove({ scope: item.scope, scopeId: item.scopeId })}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
