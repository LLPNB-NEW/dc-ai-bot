import { useState } from 'react';
import {
  ApiError,
  deleteHistoryMessage,
  describeError,
  fetchSummaryMessages,
  type SummaryMessage,
} from '../api';

// §62：一次列最近 50 条短期记忆；够点到最近这几天，又不至于把页面拉成无限长。
const HISTORY_LIMIT = 50;

// 列表里每行只露正文前 80 字：删的是整条，看全文去 Discord。
const PREVIEW_CHARS = 80;

const ROLE_LABELS: Record<SummaryMessage['role'], string> = {
  system: '系统',
  user: '用户',
  assistant: 'Bot',
};

// Discord 侧的结局翻成一句人话：接口照实回码，页面不把码直接甩给使用者。
function describeDiscord(outcome: string, detail: string): string {
  if (outcome === 'deleted') return 'Discord 里那条也删掉了';
  if (outcome === 'not_found') return 'Discord 上已找不到这条（可能早被删了），库里已删';
  if (outcome === 'ambiguous') return 'Discord 上有多条一模一样的内容，没敢猜是哪条；库里已删';
  if (outcome === 'no_token') return '服务端没配 DISCORD_BOT_TOKEN，Discord 侧没动；库里已删';
  if (outcome === 'skipped') return '服务端没接线 Discord 删除，只在库里删掉了';
  return 'Discord 侧没删成：' + (detail === '' ? '没给原因' : detail) + '；库里已删';
}

function describeDeleteError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'MESSAGE_NOT_FOUND') return '这条已经不在库里了：刷新一下列表';
    if (error.code === 'BAD_MESSAGE_ID') return '消息 ID 不合法';
    if (error.code === 'HISTORY_DELETE_UNAVAILABLE') return '服务端没有接上删除能力，暂时删不了';
    if (error.status === 401) return describeError(error);
  }
  return '删除失败：' + describeError(error);
}

function previewContent(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= PREVIEW_CHARS ? flat : chars.slice(0, PREVIEW_CHARS).join('') + '…';
}

function formatTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '未知时间';
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? iso : value.toLocaleString('zh-CN', { hour12: false });
}

export default function HistoryPage() {
  const [guildId, setGuildId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [items, setItems] = useState<SummaryMessage[]>([]);
  const [loadedKey, setLoadedKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const key = guildId.trim() + ':' + channelId.trim();
  // 填的 ID 和列表对应的不是同一个频道时，删除按钮一律禁用：别看着 A 频道删了 B 频道的行。
  const stale = loadedKey !== '' && loadedKey !== key;

  async function read(): Promise<void> {
    const guild = guildId.trim();
    const channel = channelId.trim();
    if (busy || guild === '' || channel === '') {
      setError('先填服务器 ID 和频道 ID');
      return;
    }
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const rows = await fetchSummaryMessages(guild, channel, HISTORY_LIMIT);
      // 接口按 id 升序给；页面把最新的那一行放最上面，删起来不用往下翻。
      setItems([...rows].reverse());
      setLoadedKey(key);
      setMessage(rows.length === 0 ? '这个频道还没有短期记忆' : '已载入最近 ' + String(rows.length) + ' 条');
    } catch (err) {
      setItems([]);
      setLoadedKey('');
      setError('读取失败：' + describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: SummaryMessage): Promise<void> {
    if (busy || stale) return;
    const where = item.role === 'assistant' ? 'Bot 的那条回复' : '「' + (item.author ?? '未知用户') + '」的发言';
    // 删除是双向的（库里 + Discord），一定要人点过一次确认；取消就什么都不做。
    if (!window.confirm('删除这条' + where + '？\n\n' + previewContent(item.content) + '\n\n库里和 Discord 里的都会删掉。')) {
      return;
    }
    setDeleting(item.id);
    setMessage('');
    setError('');
    try {
      const result = await deleteHistoryMessage(item.id);
      setItems((rows) => rows.filter((row) => row.id !== item.id));
      setMessage('已删掉第 ' + String(item.id) + ' 条：' + describeDiscord(result.discord, result.detail));
    } catch (err) {
      setError(describeDeleteError(err));
    } finally {
      setDeleting(0);
    }
  }

  return (
    <div className="page history">
      <section className="card">
        <h2>短期记忆（历史行）</h2>
        <p className="hint">
          这里就是喂给模型的最近对话：删掉一条，下一轮它就不再记得这句话。删除会同时删掉 Discord 里那条消息，
          Discord 侧删不掉时库里照样删，结果照实写在这行下面。
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
            <button type="button" className="primary" disabled={busy} onClick={() => void read()}>
              {busy ? '读取中…' : '读取'}
            </button>
          </div>
        </div>
        {message === '' ? null : <p className="ok">{message}</p>}
        {error === '' ? null : <p className="error">{error}</p>}
        {stale ? <p className="error">ID 改过了：点「读取」换成这个频道的列表再删</p> : null}
        {items.length === 0 ? null : (
          <ul className="items history-list">
            {items.map((item) => (
              <li key={item.id}>
                <span className="badge">#{String(item.id)}</span>
                <span className="badge">{ROLE_LABELS[item.role]}</span>
                <span className="badge">{item.author ?? '未知作者'}</span>
                <span className="hint history-time">{formatTime(item.createdAt)}</span>
                <span className="hint history-content">{previewContent(item.content)}</span>
                <button
                  type="button"
                  className="danger"
                  disabled={busy || stale || deleting !== 0}
                  onClick={() => void remove(item)}
                >
                  {deleting === item.id ? '删除中…' : '删除'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
