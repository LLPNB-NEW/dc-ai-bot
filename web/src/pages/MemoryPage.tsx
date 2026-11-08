import { useEffect, useState } from 'react';
import {
  ApiError,
  MEMORY_DEFAULTS,
  deleteChannelMemory,
  describeError,
  fetchChannelMemory,
  fetchMemorySettings,
  saveChannelMemory,
  type ChannelMemoryConfig,
} from '../api';

// §26.1 注入条数只有下界 2（不设上限）：前端先拦一遍，服务端 §26.4 仍会再校验。
const MEMORY_MIN = 2;
// 记忆注入预算（字符）：0 / 空 = 未设置（运行时按 4000），非零必须落在 500..20000。
const BUDGET_MIN = 500;
const BUDGET_MAX = 20000;

/** 频道的维度键（§26.2 ChannelKey）；同时用来记住表单现在绑定的是哪个频道。 */
interface MemoryKey {
  guildId: string;
  channelId: string;
}

// 同一时刻只允许一件事在跑：读与写共用一个 busy，写操作因此天然单飞。
type BusyKind = '' | 'read' | 'save' | 'reset';

function sameKey(left: MemoryKey, right: MemoryKey): boolean {
  return left.guildId === right.guildId && left.channelId === right.channelId;
}

// §26.4 这四条路由只回错误码，翻成中文再显示，不把码直接甩给用户。
function describeMemoryError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_CHANNEL_KEY') return '服务器 / 频道 ID 不合法：只能是 1–32 位数字';
    if (error.code === 'BAD_MEMORY_SETTINGS') {
      return (
        '记忆参数不合法：注入条数 ≥ 2，自动总结阈值只能填 0（关闭）或 ≥ 2，' +
        '注入预算要么留空（默认 4000）要么填 500–20000'
      );
    }
    if (error.code === 'BAD_CONTEXT_TOOL') return '上下文工具模式只能是开 / 关，请重新勾选后再保存';
    // 401 的 message 本身就是中文（登录已失效），不再加前缀。
    if (error.status === 401) return describeError(error);
  }
  return '记忆配置操作失败：' + describeError(error);
}

// §26.4 只接受整数：空串与非纯数字都返回 null，由调用方报出具体是哪一项。
function parseMemoryNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

// 注入预算多一条「留空」：空串与 0 都按「未设置」提交（后端 0 = 未设置，运行时用 4000）。
function parseBudget(raw: string): number | null {
  if (raw.trim() === '') return 0;
  const value = parseMemoryNumber(raw);
  if (value === null) return null;
  return value === 0 || (value >= BUDGET_MIN && value <= BUDGET_MAX) ? value : null;
}

// 库里存 0 表示未设置：渲染时按运行时的默认 4000 显示，别把「未设置」画成 0。
function displayBudget(summaryMaxChars: number): number {
  return summaryMaxChars === 0 ? MEMORY_DEFAULTS.summaryMaxChars : summaryMaxChars;
}

// 只到秒：库里是 ISO，毫秒对排查没意义，还会把列表行撑宽。
function formatUpdatedAt(updatedAt: string): string {
  if (updatedAt === '') return '未知时间';
  const value = new Date(updatedAt);
  if (Number.isNaN(value.getTime())) return updatedAt;
  return value.toLocaleString('zh-CN', { hour12: false });
}

/** §26.6 行文案：服务器 ID · 频道 ID · 窗口 N · 阈值 N / 关闭 · 预算 N。 */
function describeRow(item: ChannelMemoryConfig): string {
  const threshold =
    item.summaryEveryMessages === 0 ? '关闭自动总结' : '阈值 ' + String(item.summaryEveryMessages);
  return (
    '服务器 ' +
    item.guildId +
    ' · 频道 ' +
    item.channelId +
    ' · 窗口 ' +
    String(item.historyMaxMessages) +
    ' · ' +
    threshold +
    ' · 预算 ' +
    String(displayBudget(item.summaryMaxChars))
  );
}

/** §26.2 没有行 = 默认值；「恢复默认」成功后表单要落回的就是这三个数字。 */
function describeDefaults(): string {
  return (
    '窗口 ' +
    String(MEMORY_DEFAULTS.historyMaxMessages) +
    ' · 阈值 ' +
    String(MEMORY_DEFAULTS.summaryEveryMessages) +
    ' · 预算 ' +
    String(MEMORY_DEFAULTS.summaryMaxChars)
  );
}

export default function MemoryPage() {
  const [guildId, setGuildId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [items, setItems] = useState<ChannelMemoryConfig[]>([]);
  const [loadedKey, setLoadedKey] = useState<MemoryKey | null>(null);
  const [historyMax, setHistoryMax] = useState(String(MEMORY_DEFAULTS.historyMaxMessages));
  const [summaryEvery, setSummaryEvery] = useState(String(MEMORY_DEFAULTS.summaryEveryMessages));
  const [summaryBudget, setSummaryBudget] = useState(String(MEMORY_DEFAULTS.summaryMaxChars));
  // §55 上下文工具模式：默认关，读回 / 保存 / 恢复默认都要跟着整行走
  const [contextTool, setContextTool] = useState(false);
  const [busy, setBusy] = useState<BusyKind>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void refreshMemorySettings().catch((err: unknown) => setError(describeMemoryError(err)));
  }, []);

  function currentKey(): MemoryKey | null {
    const guild = guildId.trim();
    const channel = channelId.trim();
    return guild === '' || channel === '' ? null : { guildId: guild, channelId: channel };
  }

  async function refreshMemorySettings(): Promise<void> {
    setItems(await fetchMemorySettings());
  }

  // 列表刷新失败不该盖掉「已保存」这类结论，单独报一句就够了。
  async function refreshListAfter(action: string): Promise<void> {
    try {
      await refreshMemorySettings();
    } catch (err) {
      setError(action + '，但刷新已保存列表失败：' + describeError(err));
    }
  }

  function applyNumbers(historyMaxMessages: number, summaryEveryMessages: number, summaryMaxChars: number): void {
    setHistoryMax(String(historyMaxMessages));
    setSummaryEvery(String(summaryEveryMessages));
    setSummaryBudget(String(displayBudget(summaryMaxChars)));
  }

  // 按明确的 key 读回来：点列表行时 setState 要等到下一轮渲染才生效，不能回头再取一次 currentKey()。
  async function readKey(key: MemoryKey): Promise<void> {
    if (busy !== '') return;
    setBusy('read');
    setMessage('');
    setError('');
    try {
      const cfg = await fetchChannelMemory(key.guildId, key.channelId);
      // 服务端回的才是权威值（含服务端自己取的 updatedAt 与默认值），表单跟着它走。
      setGuildId(cfg.guildId);
      setChannelId(cfg.channelId);
      applyNumbers(cfg.historyMaxMessages, cfg.summaryEveryMessages, cfg.summaryMaxChars);
      setContextTool(cfg.contextTool);
      setLoadedKey({ guildId: cfg.guildId, channelId: cfg.channelId });
      setMessage(
        cfg.updatedAt === ''
          ? '这个频道还没单独设置过，显示的是默认值'
          : '已读取：' + describeRow(cfg) + '（更新于 ' + formatUpdatedAt(cfg.updatedAt) + '）',
      );
    } catch (err) {
      // 读失败时表单一律不动，免得把上一次载入的值当成这次的结果。
      setError(describeMemoryError(err));
    } finally {
      setBusy('');
    }
  }

  function read(): void {
    const key = currentKey();
    if (key === null) return;
    void readKey(key);
  }

  // §26.6 点已保存列表的一行：把 ID 填进表单，再按这一对的 ID 读回来（不在本地猜参数）。
  function select(item: ChannelMemoryConfig): void {
    if (busy !== '') return;
    setGuildId(item.guildId);
    setChannelId(item.channelId);
    void readKey({ guildId: item.guildId, channelId: item.channelId });
  }

  async function save(): Promise<void> {
    const key = currentKey();
    if (busy !== '' || key === null || loadedKey === null || !sameKey(key, loadedKey)) return;
    setMessage('');
    setError('');
    const history = parseMemoryNumber(historyMax);
    if (history === null || history < MEMORY_MIN) {
      setError('注入条数必须是 ≥ 2 的整数');
      return;
    }
    const threshold = parseMemoryNumber(summaryEvery);
    if (threshold === null || (threshold !== 0 && threshold < MEMORY_MIN)) {
      setError('自动总结阈值只能填 0（关闭）或 ≥ 2 的整数');
      return;
    }
    const budget = parseBudget(summaryBudget);
    if (budget === null) {
      setError(
        '记忆注入预算只能留空（默认 ' +
          String(MEMORY_DEFAULTS.summaryMaxChars) +
          '）或填 ' +
          String(BUDGET_MIN) +
          '–' +
          String(BUDGET_MAX) +
          ' 之间的整数',
      );
      return;
    }
    setBusy('save');
    try {
      const saved = await saveChannelMemory({
        guildId: key.guildId,
        channelId: key.channelId,
        historyMaxMessages: history,
        summaryEveryMessages: threshold,
        summaryMaxChars: budget,
        contextTool,
      });
      setGuildId(saved.guildId);
      setChannelId(saved.channelId);
      applyNumbers(saved.historyMaxMessages, saved.summaryEveryMessages, saved.summaryMaxChars);
      setContextTool(saved.contextTool);
      setLoadedKey({ guildId: saved.guildId, channelId: saved.channelId });
      setMessage('已保存：' + describeRow(saved) + '（更新于 ' + formatUpdatedAt(saved.updatedAt) + '）');
      await refreshListAfter('已保存');
    } catch (err) {
      setError(describeMemoryError(err));
    } finally {
      setBusy('');
    }
  }

  async function reset(): Promise<void> {
    const key = currentKey();
    if (busy !== '' || key === null) return;
    // §26.7 删除行 = 回到默认值且不保留历史值，先要一次明确确认。
    if (!window.confirm('确定删掉服务器 ' + key.guildId + ' 频道 ' + key.channelId + ' 的单独设置？恢复后回到 ' + describeDefaults() + '。')) {
      return;
    }
    setMessage('');
    setError('');
    setBusy('reset');
    try {
      await deleteChannelMemory(key.guildId, key.channelId);
      // 行已经删了，表单落回默认值；updatedAt 不再有意义，所以只提示「未单独设置」。
      applyNumbers(MEMORY_DEFAULTS.historyMaxMessages, MEMORY_DEFAULTS.summaryEveryMessages, MEMORY_DEFAULTS.summaryMaxChars);
      setContextTool(false);
      setLoadedKey(key);
      setMessage(
        '已恢复默认：' +
          describeRow({
            guildId: key.guildId,
            channelId: key.channelId,
            ...MEMORY_DEFAULTS,
            contextTool: false,
            updatedAt: '',
          }) +
          '（该频道不再有单独设置）',
      );
      await refreshListAfter('已恢复默认');
    } catch (err) {
      setError(describeMemoryError(err));
    } finally {
      setBusy('');
    }
  }

  const key = currentKey();
  const keyMissing = key === null;
  const keyStale = key !== null && loadedKey !== null && !sameKey(key, loadedKey);
  // 保存要有确定的目标：ID 没填、或绑定的频道已经被改成别的 ID 时一律禁用。
  const saveDisabled = busy !== '' || keyMissing || loadedKey === null || keyStale;
  // 恢复默认只需要一对合法的 ID（DELETE 不依赖表单里的数字）。
  const resetDisabled = busy !== '' || keyMissing;

  return (
    <div className="page memory">
      <div className="memory-main">
        <section className="card">
          <h2>读取频道配置</h2>
          <p className="hint">
            每个频道各自一套：注入条数 = 每轮带多少条原文，自动总结阈值 = 攒够多少条触发总结（0 = 关闭）
          </p>
          <div className="row memory-key">
            <label className="field">
              <span>服务器 ID</span>
              <input
                type="text"
                value={guildId}
                placeholder="例如 1234567890123456789"
                onChange={(event) => setGuildId(event.target.value)}
              />
            </label>
            <label className="field">
              <span>频道 ID</span>
              <input
                type="text"
                value={channelId}
                placeholder="例如 9876543210987654321"
                onChange={(event) => setChannelId(event.target.value)}
              />
            </label>
            <div className="actions">
              <button type="button" className="primary" disabled={busy !== '' || keyMissing} onClick={read}>
                {busy === 'read' ? '读取中…' : '读取'}
              </button>
            </div>
          </div>
          {message === '' ? null : <p className="ok">{message}</p>}
          {error === '' ? null : <p className="error">{error}</p>}
        </section>

        <form
          className="card"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h2>记忆参数</h2>
          <p className="hint">
            {loadedKey === null
              ? '先在上面填服务器 / 频道 ID 点「读取」，或点右侧列表的一行把它载入表单'
              : keyStale
                ? 'ID 改过了：请重新点「读取」，免得把参数写到别的频道'
                : '当前：服务器 ' + loadedKey.guildId + ' · 频道 ' + loadedKey.channelId}
          </p>
          <div className="row memory-numbers">
            <label className="field memory-number">
              <span>注入条数（默认 50，≥ 2，不设上限）</span>
              <input
                type="number"
                min={MEMORY_MIN}
                step={1}
                value={historyMax}
                onChange={(event) => setHistoryMax(event.target.value)}
              />
            </label>
            <label className="field memory-number">
              <span>自动总结阈值（默认 50；0 = 关闭自动总结，否则 ≥ 2，不设上限）</span>
              <input
                type="number"
                min={0}
                step={1}
                value={summaryEvery}
                onChange={(event) => setSummaryEvery(event.target.value)}
              />
            </label>
          </div>
          <div className="row memory-numbers">
            <label className="field memory-number">
              <span>记忆注入预算（字符；默认 4000，范围 500–20000）</span>
              <input
                type="number"
                min={BUDGET_MIN}
                max={BUDGET_MAX}
                step={100}
                placeholder="留空 = 默认 4000"
                value={summaryBudget}
                onChange={(event) => setSummaryBudget(event.target.value)}
              />
            </label>
          </div>
          <p className="hint">
            记忆注入预算 = 每轮把多少字的累积记忆装进 prompt：默认 4000；越大记忆越全，但每轮 prompt
            越贵；超出预算的老段仍留在库里，不删也不改。另外：注入条数填很大时每轮 prompt 会显著变长、更贵
          </p>
          <label className="row checkbox">
            <input
              type="checkbox"
              checked={contextTool}
              onChange={(event) => setContextTool(event.target.checked)}
            />
            <span>上下文工具模式（把预设与历史塞进 context 工具，只发一条用户消息）</span>
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={saveDisabled}>
              {busy === 'save' ? '保存中…' : '保存'}
            </button>
            <button type="button" className="danger" disabled={resetDisabled} onClick={() => void reset()}>
              {busy === 'reset' ? '恢复中…' : '恢复默认'}
            </button>
          </div>
        </form>
      </div>

      <section className="card">
        <h2>已保存的频道</h2>
        <p className="hint">点一行把它的服务器 / 频道 ID 填进表单并读回来；改回默认值请用「恢复默认」</p>
        {items.length === 0 ? (
          <p className="hint">还没有任何频道单独设置过：填好 ID 点「读取」，保存后才会出现在这里</p>
        ) : (
          <ul className="items memory-list">
            {items.map((item) => (
              <li key={item.guildId + ':' + item.channelId}>
                <button type="button" className="link" disabled={busy !== ''} onClick={() => select(item)}>
                  {item.channelId}
                </button>
                <span className="badge">{item.guildId}</span>
                <span className="badge">窗口 {String(item.historyMaxMessages)}</span>
                <span className={item.summaryEveryMessages === 0 ? 'badge ok-badge' : 'badge'}>
                  {item.summaryEveryMessages === 0 ? '关闭' : '阈值 ' + String(item.summaryEveryMessages)}
                </span>
                <span className="hint">{formatUpdatedAt(item.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
