import { useState } from 'react';
import { ApiError, api } from '../api';

export interface LoginPageProps {
  onSuccess: () => void;
}

export default function LoginPage(props: LoginPageProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.login(password);
      props.onSuccess();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError('口令错误');
      else if (err instanceof ApiError) setError(err.message);
      else setError('登录失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="centered">
      <form
        className="card login"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h1>DC AI BOT 管理后台</h1>
        <p className="hint">输入 Worker Secret 中配置的管理口令（ADMIN_PASSWORD）。</p>
        <label className="field">
          <span>管理口令</span>
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            placeholder="请输入管理口令"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error === '' ? null : <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </main>
  );
}
