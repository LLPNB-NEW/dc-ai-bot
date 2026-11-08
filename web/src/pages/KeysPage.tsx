import { useEffect, useState } from 'react';
import { PROVIDER_IDS, api, describeError, parseModelPatterns, type ProviderId, type ProviderKeyItem } from '../api';

export default function KeysPage() {
  const [items, setItems] = useState<ProviderKeyItem[]>([]);
  const [provider, setProvider] = useState<ProviderId>('openai-compat');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelsInput, setModelsInput] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});
  const [testingId, setTestingId] = useState('');

  useEffect(() => {
    void loadItems();
  }, []);

  async function loadItems(): Promise<void> {
    try {
      setItems(await api.listKeys());
    } catch (err) {
      setError(describeError(err));
    }
  }

  function setResult(id: string, text: string): void {
    setResults((current) => ({ ...current, [id]: text }));
  }

  async function create(): Promise<void> {
    if (busy) return;
    setMessage('');
    setError('');
    if (label.trim() === '') {
      setError('请填写备注 label');
      return;
    }
    if (apiKey.trim() === '') {
      setError('请填写 apiKey');
      return;
    }
    setBusy(true);
    const models = parseModelPatterns(modelsInput);
    try {
      const created = await api.createKey({
        provider,
        label: label.trim(),
        baseUrl: baseUrl.trim() === '' ? undefined : baseUrl.trim(),
        apiKey: apiKey.trim(),
        models: models.length === 0 ? undefined : models,
      });
      setApiKey('');
      const scope = models.length === 0 ? '适用全部模型' : '适用 ' + String(models.length) + ' 个模型';
      setMessage('已保存密钥 ' + created.label + '（提示 ' + created.keyHint + '，' + scope + '）');
      await loadItems();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: ProviderKeyItem): Promise<void> {
    if (!window.confirm('确定删除密钥 ' + item.label + '？')) return;
    setMessage('');
    setError('');
    try {
      await api.deleteKey(item.id);
      setMessage('已删除密钥 ' + item.label);
      await loadItems();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function test(item: ProviderKeyItem): Promise<void> {
    setTestingId(item.id);
    setResult(item.id, '测试中…');
    try {
      const result = await api.testKey(item.id);
      const models = result.models ?? [];
      if (models.length === 0) setResult(item.id, '连通正常，但未返回模型列表');
      else setResult(item.id, '可用模型（' + String(models.length) + '）：' + models.slice(0, 20).join('、'));
    } catch (err) {
      setResult(item.id, '测试失败：' + describeError(err));
    } finally {
      setTestingId('');
    }
  }

  return (
    <div className="page">
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h2>新增供应商密钥</h2>
        <p className="hint">明文密钥只在提交时经过一次请求，入库为 AES-256-GCM 密文，接口只回显末四位。</p>
        <div className="row">
          <label className="field">
            <span>provider</span>
            <select value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)}>
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>备注 label</span>
            <input type="text" value={label} placeholder="例如 主力 OpenAI" onChange={(event) => setLabel(event.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>baseUrl（可选，openai-compat 可指向自建兼容端点）</span>
          <input
            type="text"
            value={baseUrl}
            placeholder="https://api.openai.com/v1"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className="field">
          <span>适用模型（逗号分隔，留空 = 全部；支持 deepseek-* 通配）</span>
          <input
            type="text"
            value={modelsInput}
            spellCheck={false}
            placeholder="例如 deepseek-* 或 gpt-4o-mini，逗号分隔，留空=全部"
            onChange={(event) => setModelsInput(event.target.value)}
          />
        </label>
        <label className="field">
          <span>apiKey（明文输入，只提交一次，入库加密）</span>
          <input
            type="text"
            value={apiKey}
            spellCheck={false}
            autoComplete="off"
            placeholder="sk-..."
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        {message === '' ? null : <p className="ok">{message}</p>}
        {error === '' ? null : <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '保存中…' : '新增密钥'}
          </button>
        </div>
      </form>

      <aside className="card">
        <h2>已有密钥</h2>
        {items.length === 0 ? <p className="hint">还没有密钥。缺少密钥时对话会报 NO_KEY_FOR_PROVIDER。</p> : null}
        <ul className="items keys">
          {items.map((item) => (
            <li key={item.id}>
              <div className="key-head">
                <strong>{item.label}</strong>
                <span className={item.enabled ? 'badge ok-badge' : 'badge'}>{item.enabled ? '已启用' : '已停用'}</span>
              </div>
              <div className="hint">
                {item.provider} · {item.keyHint}
                {item.baseUrl === undefined || item.baseUrl === '' ? '' : ' · ' + item.baseUrl}
              </div>
              <div className="hint">适用模型：{item.models.length === 0 ? '全部' : item.models.join('、')}</div>
              <div className="key-actions">
                <button type="button" className="ghost small" disabled={testingId === item.id} onClick={() => void test(item)}>
                  {testingId === item.id ? '测试中…' : '测试连通性'}
                </button>
                <button type="button" className="danger small" onClick={() => void remove(item)}>
                  删除
                </button>
              </div>
              {results[item.id] === undefined ? null : <p className="result">{results[item.id]}</p>}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
