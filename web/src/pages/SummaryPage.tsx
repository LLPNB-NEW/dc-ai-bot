import { useEffect, useState } from 'react';
import {
  ApiError,
  backfillSummaryRange,
  deleteSummary,
  describeError,
  fetchBackfillRange,
  fetchSummaries,
  fetchSummaryMessages,
  regenerateSummary,
  saveSummary,
  summarizeSweep,
  type BackfillOutcome,
  type BackfillPreview,
  type ConversationSummary,
  type SummaryMessage,
} from '../api';

// §25.3 最近消息缺省 50 条：够点到最近的楼层，又不至于把页面拉成无限长。
const MESSAGE_LIMIT = 50;

// §25.6 最近消息列表每行只显示正文前 30 字。
const MESSAGE_PREVIEW_CHARS = 30;

// 摘要的维度键（§17.2 ChannelKey）；同时用来记住表单现在绑定的是哪个频道。
interface SummaryKey {
  guildId: string;
  channelId: string;
}

// §25.8 命中预览要记住它是替哪个频道、哪一段时间算的：ID 或时间改过之后不能再拿它去补记。
interface BackfillCheck {
  key: SummaryKey;
  from: string;
  to: string;
  preview: BackfillPreview;
}

const ROLE_LABELS: Record<SummaryMessage['role'], string> = {
  system: '系统',
  user: '用户',
  assistant: 'Bot',
};

// 同一时刻只允许一件事在跑：重新总结要数十秒，期间再点保存会变成后写覆盖（§25.7 无版本号）。
// §25.8 选择性补记也走同一个 busy：统计要扫消息、补记要跑模型，都不该和上面几件事并行。
type BusyKind = '' | 'read' | 'save' | 'delete' | 'regenerate' | 'range' | 'backfill' | 'sweep';

function sameKey(left: SummaryKey, right: SummaryKey): boolean {
  return left.guildId === right.guildId && left.channelId === right.channelId;
}

function findSummary(items: ConversationSummary[], key: SummaryKey): ConversationSummary | null {
  for (const item of items) {
    if (sameKey(item, key)) return item;
  }
  return null;
}

// §25.4 这五条路由只回错误码，翻成中文再显示，不把码直接甩给用户。
function describeSummaryError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_CHANNEL_KEY') return '服务器 / 频道 ID 不合法：只能是 1–32 位数字';
    if (error.code === 'BAD_SUMMARY') return '摘要正文不合法：去掉首尾空白后需 1–8000 字';
    if (error.code === 'BAD_COVERED_UNTIL') return '覆盖楼层不合法：必须是非负整数，且不超过该频道最新消息 ID';
    if (error.code === 'SUMMARY_UNAVAILABLE') return '服务端没有接上摘要能力，暂时无法重新总结';
    if (error.code === 'SUMMARY_FAILED') {
      // §25.4：502 的 detail 是模型侧真实原因（截前 300 字），带出来才好排查。
      const detail = error.payload['detail'];
      return typeof detail === 'string' && detail !== ''
        ? '重新总结失败：' + detail
        : '重新总结失败：服务端没有给出明细';
    }
    if (error.code === 'NO_SUMMARY_MATERIAL') return '没有可总结的新消息：覆盖楼层之后没有素材';
    // 401 的 message 本身就是中文（登录已失效），不再加前缀。
    if (error.status === 401) return describeError(error);
  }
  return '摘要操作失败：' + describeError(error);
}

// §25.4 coveredUntilId 是非负整数；空输入按 0（= 从头重算），非法值返回 null 由调用方报错。
function parseCoveredUntil(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function previewContent(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= MESSAGE_PREVIEW_CHARS ? flat : chars.slice(0, MESSAGE_PREVIEW_CHARS).join('') + '…';
}

function describeAuthor(item: SummaryMessage): string {
  return item.author !== undefined && item.author !== '' ? item.author : ROLE_LABELS[item.role];
}

// 只到秒：库里是 ISO，毫秒对排查没意义，还会把列表行撑宽。
function formatUpdatedAt(updatedAt: string): string {
  if (updatedAt === '') return '未知时间';
  const value = new Date(updatedAt);
  if (Number.isNaN(value.getTime())) return updatedAt;
  return value.toLocaleString('zh-CN', { hour12: false });
}

// datetime-local 的值按本地时区解释，后端要 ISO；空值或解析不出来返回 null，调用方据此不发请求。
function toIsoInstant(local: string): string | null {
  if (local.trim() === '') return null;
  const value = new Date(local);
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

export default function SummaryPage() {
  const [guildId, setGuildId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [loadedKey, setLoadedKey] = useState<SummaryKey | null>(null);
  const [body, setBody] = useState('');
  const [coveredUntil, setCoveredUntil] = useState('0');
  const [messages, setMessages] = useState<SummaryMessage[]>([]);
  const [busy, setBusy] = useState<BusyKind>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  // §25.8 补记卡的结论与报错各自成段落，不共用上面那对 message / error。
  const [fromValue, setFromValue] = useState('');
  const [toValue, setToValue] = useState('');
  const [check, setCheck] = useState<BackfillCheck | null>(null);
  const [backfillDone, setBackfillDone] = useState<BackfillOutcome | null>(null);
  const [backfillError, setBackfillError] = useState('');
  // §63 连续总结的进度：已总结条数 + 最近一批回报的剩余条数，跑完之前这两项一直在变。
  const [sweepDone, setSweepDone] = useState(0);
  const [sweepRemaining, setSweepRemaining] = useState<number | null>(null);
  const [sweepNote, setSweepNote] = useState('');
  const [sweepError, setSweepError] = useState('');

  useEffect(() => {
    void refreshSummaries().catch((err: unknown) => setError(describeSummaryError(err)));
  }, []);

  function currentKey(): SummaryKey | null {
    const guild = guildId.trim();
    const channel = channelId.trim();
    return guild === '' || channel === '' ? null : { guildId: guild, channelId: channel };
  }

  async function refreshSummaries(): Promise<ConversationSummary[]> {
    const items = await fetchSummaries();
    setSummaries(items);
    return items;
  }

  // 列表刷新失败不该盖掉「已保存」这类结论，单独报一句就够了。
  async function refreshListAfter(action: string): Promise<void> {
    try {
      await refreshSummaries();
    } catch (err) {
      setError(action + '，但刷新摘要列表失败：' + describeError(err));
    }
  }

  function applyBody(summary: string, coveredUntilId: number): void {
    setBody(summary);
    setCoveredUntil(String(coveredUntilId));
  }

  function applySummary(item: ConversationSummary | null): void {
    applyBody(item === null ? '' : item.summary, item === null ? 0 : item.coveredUntilId);
  }

  // 「读取」与「补记」之后都要把该频道的正文重新载入表单：共用这一条，不各写一份请求。
  async function loadSummary(key: SummaryKey): Promise<ConversationSummary | null> {
    const items = await refreshSummaries();
    const matched = findSummary(items, key);
    applySummary(matched);
    setLoadedKey(key);
    return matched;
  }

  async function loadMessages(key: SummaryKey): Promise<void> {
    try {
      setMessages(await fetchSummaryMessages(key.guildId, key.channelId, MESSAGE_LIMIT));
    } catch (err) {
      setMessages([]);
      setError('最近消息：' + describeSummaryError(err));
    }
  }

  async function read(): Promise<void> {
    const key = currentKey();
    if (busy !== '' || key === null) return;
    setBusy('read');
    setMessage('');
    setError('');
    try {
      const matched = await loadSummary(key);
      setMessage(matched === null ? '该频道还没有摘要：正文留空，覆盖楼层按 0（从头重算）' : '已载入摘要');
      await loadMessages(key);
    } catch (err) {
      // 列表都没拉到时表单一律不动，免得把上一次载入的内容当成这次的结果。
      setError(describeSummaryError(err));
    } finally {
      setBusy('');
    }
  }

  // §25.6 点摘要列表一行把它载入表单：纯本地动作，不打接口；最近消息仍要点「读取」才拉。
  function select(item: ConversationSummary): void {
    if (busy !== '') return;
    setGuildId(item.guildId);
    setChannelId(item.channelId);
    applySummary(item);
    setLoadedKey({ guildId: item.guildId, channelId: item.channelId });
    setMessages([]);
    setMessage('已载入频道 ' + item.channelId + ' 的摘要');
    setError('');
  }

  async function save(): Promise<void> {
    const key = currentKey();
    if (busy !== '' || key === null || loadedKey === null || !sameKey(key, loadedKey)) return;
    setMessage('');
    setError('');
    if (body.trim() === '') {
      setError('摘要正文不能为空');
      return;
    }
    const floor = parseCoveredUntil(coveredUntil);
    if (floor === null) {
      setError('覆盖楼层必须是非负整数（0 = 从头重算）');
      return;
    }
    setBusy('save');
    try {
      const saved = await saveSummary({ guildId: key.guildId, channelId: key.channelId, summary: body, coveredUntilId: floor });
      // 后端回的才是存进去的那一份（含服务端自己取的 updatedAt），表单跟着它走。
      applySummary(saved);
      setMessage('已保存');
      await refreshListAfter('已保存');
    } catch (err) {
      setError(describeSummaryError(err));
    } finally {
      setBusy('');
    }
  }

  async function regenerate(): Promise<void> {
    const key = currentKey();
    if (busy !== '' || key === null) return;
    setMessage('');
    setError('');
    // 正文里已经有字时，重新总结会把它整段覆盖掉（§25.7），先要一次明确确认。
    if (body.trim() !== '' && !window.confirm('重新总结会用模型结果覆盖当前正文与覆盖楼层，确定继续？')) return;
    setBusy('regenerate');
    try {
      const outcome = await regenerateSummary(key.guildId, key.channelId);
      setLoadedKey(key);
      applyBody(outcome.summary, outcome.coveredUntilId);
      setMessage(
        '已重新总结：' +
          String(outcome.summarizedMessages) +
          ' 条素材，模型 ' +
          (outcome.model === '' ? '未知' : outcome.model),
      );
      await refreshListAfter('已重新总结');
    } catch (err) {
      setError(describeSummaryError(err));
    } finally {
      setBusy('');
    }
  }

  async function remove(): Promise<void> {
    const key = currentKey();
    if (busy !== '' || key === null) return;
    // §25.7 删掉后自动总结从 0 重来，且已删的原文不会回来：先要一次明确确认。
    if (!window.confirm('确定删除服务器 ' + key.guildId + ' 频道 ' + key.channelId + ' 的摘要？删除后自动总结会从 0 重来。')) {
      return;
    }
    setMessage('');
    setError('');
    setBusy('delete');
    try {
      await deleteSummary(key.guildId, key.channelId);
      // §25.6 删除成功清空表单：正文与覆盖楼层一起归零，最近消息也不再对着已删的摘要。
      applyBody('', 0);
      setMessages([]);
      setLoadedKey(null);
      setMessage('已删除该频道的摘要（覆盖楼层归 0）');
      await refreshListAfter('已删除');
    } catch (err) {
      setError(describeSummaryError(err));
    } finally {
      setBusy('');
    }
  }

  // §25.8 先只统计不写库：命中多少、首尾长什么样、会不会超上限，都由这一步回答。
  async function preview(): Promise<void> {
    const target = currentKey();
    const from = toIsoInstant(fromValue);
    const to = toIsoInstant(toValue);
    if (busy !== '' || target === null || from === null || to === null) return;
    setBusy('range');
    setBackfillError('');
    setBackfillDone(null);
    try {
      setCheck({ key: target, from, to, preview: await fetchBackfillRange(target.guildId, target.channelId, from, to) });
    } catch (err) {
      // 统计失败就把上一次的命中清掉：拿旧预览去补记，补的会是别的范围。
      setCheck(null);
      setBackfillError(describeError(err));
    } finally {
      setBusy('');
    }
  }

  async function backfill(): Promise<void> {
    if (busy !== '' || activeCheck === null) return;
    // 空范围与超上限都不发请求：后端一样会拒，没必要白跑一趟模型。
    if (activeCheck.preview.count === 0 || activeCheck.preview.tooLarge) return;
    setBusy('backfill');
    setBackfillError('');
    setBackfillDone(null);
    try {
      const outcome = await backfillSummaryRange(
        activeCheck.key.guildId,
        activeCheck.key.channelId,
        activeCheck.from,
        activeCheck.to,
      );
      setBackfillDone(outcome);
      // 补完这一段就从预览里撤掉：同一段再点一次会往记忆里重复追加一遍。
      setCheck(null);
      try {
        await loadSummary(activeCheck.key);
      } catch (err) {
        // 补记本身已经成功，刷新正文失败只报这一句，不改口说补记失败。
        setBackfillError('已补记，但刷新摘要正文失败：' + describeError(err));
      }
    } catch (err) {
      setBackfillError(describeError(err));
    } finally {
      setBusy('');
    }
  }

  /**
   * §63 连续总结：一批 500 条发一次请求，拿到 remaining 就接着发下一批，直到剩 0。
   * 中途失败就停在这里——进度已经在库里（游标），再点一次会从同一处接着走，不会重做已完成的批次。
   * remaining 不减少说明这一批没消化掉任何原文（服务端异常），必须停手，否则会无限打模型。
   */
  async function sweep(): Promise<void> {
    const target = currentKey();
    if (busy !== '' || target === null) return;
    if (!window.confirm('连续总结会一批批调用模型（每批最多 500 条），直到把覆盖楼层之后的原文消化完，确定开始？')) {
      return;
    }
    setBusy('sweep');
    setMessage('');
    setError('');
    setSweepError('');
    setSweepNote('');
    setSweepDone(0);
    setSweepRemaining(null);
    let done = 0;
    let previous = Number.POSITIVE_INFINITY;
    try {
      for (;;) {
        const result = await summarizeSweep(target.guildId, target.channelId);
        const added = result.outcome === null ? 0 : result.outcome.summarizedMessages;
        done += added;
        setSweepDone(done);
        setSweepRemaining(result.remaining);
        if (result.outcome === null) {
          // 没有素材：要么本来就没有未总结的原文，要么刚好处在游标末尾，都不必再发下一批
          setSweepNote('覆盖楼层之后没有可总结的原文了');
          break;
        }
        if (result.remaining <= 0) {
          setSweepNote('已把未总结的原文全部消化完');
          break;
        }
        if (result.remaining >= previous) {
          setSweepNote('这一批没有让剩余变少，先停下等等再看（已完成的批次不会白做）');
          break;
        }
        previous = result.remaining;
      }
      // 正文与列表跟着刷新一次：接力过程中游标、正文都在变，页面不能拿着旧的那份给人看
      try {
        await loadSummary(target);
      } catch (err) {
        setSweepNote((prev) => (prev === '' ? '' : prev + '；') + '刷新摘要正文失败：' + describeError(err));
      }
      await refreshListAfter('连续总结');
    } catch (err) {
      setSweepError(describeSummaryError(err));
    } finally {
      setBusy('');
    }
  }

  const key = currentKey();
  const keyMissing = key === null;
  const keyStale = key !== null && loadedKey !== null && !sameKey(key, loadedKey);
  // 表单没绑定频道、或绑定的频道已经被改成别的 ID 时，写操作没有确定的目标，一律禁用。
  const writeDisabled = busy !== '' || keyMissing || loadedKey === null || keyStale;
  // §25.8 命中预览只在「同一个频道 + 同一段时间」都还没变时才允许补记。
  const fromIso = toIsoInstant(fromValue);
  const toIso = toIsoInstant(toValue);
  const activeCheck =
    check !== null && key !== null && sameKey(check.key, key) && check.from === fromIso && check.to === toIso ? check : null;
  const checkStale = check !== null && activeCheck === null;
  const previewDisabled = busy !== '' || keyMissing || fromIso === null || toIso === null;
  const backfillDisabled =
    busy !== '' || activeCheck === null || activeCheck.preview.count === 0 || activeCheck.preview.tooLarge;

  return (
    <div className="page summary">
      <section className="card">
        <h2>读取摘要</h2>
        <p className="hint">
          覆盖楼层 = 已总结到 messages.id 的哪一条，下次只捞比它新的；改小会把一段原文重新纳入待总结，改大会主动放弃那一段
        </p>
        <div className="row summary-key">
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
            <button type="button" className="primary" disabled={busy !== '' || keyMissing} onClick={() => void read()}>
              {busy === 'read' ? '读取中…' : '读取'}
            </button>
          </div>
        </div>
        {message === '' ? null : <p className="ok">{message}</p>}
        {error === '' ? null : <p className="error">{error}</p>}
        {summaries.length === 0 ? (
          <p className="hint">还没有任何摘要：先在 Discord 里用 /summary 总结一次，或填好 ID 点「读取」后手写一条</p>
        ) : (
          <ul className="items summary-list">
            {summaries.map((item) => (
              <li key={item.guildId + ':' + item.channelId}>
                <button type="button" className="link" disabled={busy !== ''} onClick={() => select(item)}>
                  {item.channelId}
                </button>
                <span className="badge">{item.guildId}</span>
                <span className="badge">覆盖到 #{String(item.coveredUntilId)}</span>
                <span className="hint">{formatUpdatedAt(item.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2>正文与覆盖楼层</h2>
        <p className="hint">
          {loadedKey === null
            ? '先在上面填服务器 / 频道 ID 点「读取」，或点摘要列表的一行把它载入表单'
            : keyStale
              ? 'ID 改过了：请重新点「读取」，免得把上一条的正文写到别的频道'
              : '当前：服务器 ' + loadedKey.guildId + ' · 频道 ' + loadedKey.channelId}
        </p>
        <label className="field">
          <span>摘要正文（换行原样保存与注入，不做 markdown 处理）</span>
          <textarea
            rows={12}
            value={body}
            placeholder="例如：用户 A 在讨论部署方案，最后决定用 Workers；用户 B 问过计费，答案是按请求数算…"
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <div className="row summary-floor">
          <label className="field floor">
            <span>覆盖楼层（0 = 从头重算）</span>
            <input
              type="number"
              min={0}
              step={1}
              value={coveredUntil}
              onChange={(event) => setCoveredUntil(event.target.value)}
            />
          </label>
        </div>
        <div className="actions">
          <button type="submit" className="primary" disabled={writeDisabled}>
            {busy === 'save' ? '保存中…' : '保存'}
          </button>
          <button type="button" className="ghost" disabled={writeDisabled} onClick={() => void regenerate()}>
            {busy === 'regenerate' ? '正在总结…' : '重新总结'}
          </button>
          <button type="button" className="danger" disabled={writeDisabled} onClick={() => void remove()}>
            {busy === 'delete' ? '删除中…' : '删除'}
          </button>
        </div>
      </form>

      <section className="card">
        <h2>连续总结</h2>
        <p className="hint">
          只处理覆盖楼层之后还没进记忆的原文，按段追加到记忆末尾；每批最多 500 条，页面自动接力直到没有剩余，中途失败可以再点一次接着走
        </p>
        <div className="actions">
          <button type="button" className="primary" disabled={busy !== '' || keyMissing} onClick={() => void sweep()}>
            {busy === 'sweep' ? '正在连续总结…' : '连续总结（每批 500 条）'}
          </button>
        </div>
        {keyMissing ? <p className="hint">先在上面填好服务器 / 频道 ID，连续总结才有目标频道</p> : null}
        {sweepRemaining === null ? null : (
          <p className="ok">
            已总结 {String(sweepDone)} 条 · 还剩 {String(sweepRemaining)} 条
          </p>
        )}
        {sweepNote === '' ? null : <p className="hint">{sweepNote}</p>}
        {sweepError === '' ? null : <p className="error">{sweepError}</p>}
      </section>

      <section className="card">
        <h2>最近消息</h2>
        <p className="hint">点一行把它的 id 填进覆盖楼层（最多 {String(MESSAGE_LIMIT)} 条）</p>
        {messages.length === 0 ? (
          <p className="hint">
            {loadedKey === null ? '点上面的「读取」后会列出该频道最近的消息' : '这个频道还没有已落库的消息'}
          </p>
        ) : (
          <ul className="items summary-messages">
            {messages.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="link"
                  disabled={busy !== ''}
                  onClick={() => setCoveredUntil(String(item.id))}
                >
                  #{String(item.id)}
                </button>
                <span className="summary-author">{describeAuthor(item)}</span>
                <span className="hint">{previewContent(item.content)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>选择性补记</h2>
        <p className="hint">挑一段时间里的消息，让模型压成一段新记忆追加到末尾；不会改动自动总结的进度</p>
        <div className="row">
          <label className="field">
            <span>起始时间（本地时区）</span>
            <input type="datetime-local" value={fromValue} onChange={(event) => setFromValue(event.target.value)} />
          </label>
          <label className="field">
            <span>结束时间（本地时区）</span>
            <input type="datetime-local" value={toValue} onChange={(event) => setToValue(event.target.value)} />
          </label>
        </div>
        <div className="actions">
          <button type="button" className="ghost" disabled={previewDisabled} onClick={() => void preview()}>
            {busy === 'range' ? '正在统计…' : '查看命中'}
          </button>
          <button type="button" className="primary" disabled={backfillDisabled} onClick={() => void backfill()}>
            {busy === 'backfill' ? '正在补记…' : '补记'}
          </button>
        </div>
        {keyMissing ? <p className="hint">先在上面填好服务器 / 频道 ID，补记才有目标频道</p> : null}
        {activeCheck === null ? null : (
          <>
            <p className="ok">命中 {String(activeCheck.preview.count)} 条</p>
            {activeCheck.preview.count === 0 ? <p className="hint">这段时间没有消息</p> : null}
            {activeCheck.preview.tooLarge ? <p className="error">一次最多 500 条，请把范围缩小</p> : null}
            {activeCheck.preview.firstAt === undefined ? null : (
              <p className="hint">最早一条：{formatUpdatedAt(activeCheck.preview.firstAt)}</p>
            )}
            {activeCheck.preview.lastAt === undefined ? null : (
              <p className="hint">最晚一条：{formatUpdatedAt(activeCheck.preview.lastAt)}</p>
            )}
            {activeCheck.preview.samples.length === 0 ? null : (
              <ul className="backfill-samples">
                {activeCheck.preview.samples.map((sample, index) => (
                  <li key={String(index)}>{sample}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {checkStale ? <p className="hint">时间或 ID 改过了：请重新点「查看命中」</p> : null}
        {backfillDone === null ? null : (
          <p className="ok">
            已补记 {String(backfillDone.summarizedMessages)} 条，记忆现在共 {String(backfillDone.summaryLength)} 字
          </p>
        )}
        {backfillError === '' ? null : <p className="error">{backfillError}</p>}
      </section>
    </div>
  );
}
