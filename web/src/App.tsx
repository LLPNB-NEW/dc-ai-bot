import { useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';
import LoginPage from './pages/LoginPage';
import PromptsPage from './pages/PromptsPage';
import RoutesPage from './pages/RoutesPage';
import KeysPage from './pages/KeysPage';
import LogsPage from './pages/LogsPage';
import ReactionPage from './pages/ReactionPage';
import SummaryPage from './pages/SummaryPage';
import MemoryPage from './pages/MemoryPage';
import HistoryPage from './pages/HistoryPage';
import BackupPage from './pages/BackupPage';
import ReplyPage from './pages/ReplyPage';
import VoicePage from './pages/VoicePage';
import ErrorsPage from './pages/ErrorsPage';
import TimeoutsPage from './pages/TimeoutsPage';

type Phase = 'checking' | 'anonymous' | 'authed';
type Tab =
  | 'prompts'
  | 'routes'
  | 'reaction'
  | 'summary'
  | 'history'
  | 'memory'
  | 'backup'
  | 'voice'
  | 'reply'
  | 'timeouts'
  | 'errors'
  | 'keys'
  | 'logs';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'prompts', label: '提示词' },
  { id: 'routes', label: '模型路由' },
  { id: 'reaction', label: '表情' },
  { id: 'summary', label: '摘要' },
  { id: 'history', label: '历史' },
  { id: 'memory', label: '记忆' },
  { id: 'backup', label: '备份' },
  { id: 'voice', label: '语音' },
  { id: 'reply', label: '回复' },
  { id: 'timeouts', label: '超时' },
  { id: 'errors', label: '故障' },
  { id: 'keys', label: '供应商密钥' },
  { id: 'logs', label: '实时日志' },
];

export default function App() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [tab, setTab] = useState<Tab>('prompts');

  useEffect(() => {
    setUnauthorizedHandler(() => setPhase('anonymous'));
    api
      .me()
      .then(() => setPhase('authed'))
      .catch(() => setPhase('anonymous'));
    return () => setUnauthorizedHandler(null);
  }, []);

  async function handleLogout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      // 会话本已失效时仍要回登录页，退出失败不阻塞。
    }
    setPhase('anonymous');
  }

  if (phase === 'checking') return <main className="centered">正在确认登录状态…</main>;
  if (phase === 'anonymous') return <LoginPage onSuccess={() => setPhase('authed')} />;

  return (
    <div className="app">
      <header className="topbar">
        <strong className="brand">DC AI BOT 管理后台</strong>
        <nav className="tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === tab ? 'tab active' : 'tab'}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <button type="button" className="ghost" onClick={handleLogout}>
          退出登录
        </button>
      </header>
      <main className="content">
        {tab === 'prompts' ? <PromptsPage /> : null}
        {tab === 'routes' ? <RoutesPage /> : null}
        {tab === 'reaction' ? <ReactionPage /> : null}
        {tab === 'summary' ? <SummaryPage /> : null}
        {tab === 'history' ? <HistoryPage /> : null}
        {tab === 'memory' ? <MemoryPage /> : null}
        {tab === 'backup' ? <BackupPage /> : null}
        {tab === 'voice' ? <VoicePage /> : null}
        {tab === 'reply' ? <ReplyPage /> : null}
        {tab === 'timeouts' ? <TimeoutsPage /> : null}
        {tab === 'errors' ? <ErrorsPage /> : null}
        {tab === 'keys' ? <KeysPage /> : null}
        {tab === 'logs' ? <LogsPage /> : null}
      </main>
    </div>
  );
}
