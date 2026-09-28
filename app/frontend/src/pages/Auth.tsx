import { useState } from 'react';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';

/** 登录 / 注册页。未配置 Supabase 时给出明确的配置入口说明。 */
export default function Auth() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (signUpError) throw signUpError;
        setNotice('注册成功。若项目开启了邮箱验证,请先在邮箱中确认后再登录。');
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-6">
      <div className="w-full max-w-[420px]">
        <div className="mb-8">
          <div className="h-1 w-16 bg-[var(--accent)] mb-4" />
          <h1 className="text-[20px] leading-7 font-semibold">Forge</h1>
          <p className="text-[13px] text-[var(--text-2)] mt-1">
            一句话需求 → 真实模型生成代码 → 隔离沙箱运行 → 实时预览
          </p>
        </div>

        {!isSupabaseConfigured && (
          <div className="mb-6 border border-[var(--danger)] rounded-[8px] p-4 text-[12px] leading-5 text-[var(--text)]">
            <p className="font-semibold text-[var(--danger)] mb-2">尚未配置 Supabase</p>
            <p className="text-[var(--text-2)]">
              请在 <code className="font-mono">app/frontend/.env</code> 中填写{' '}
              <code className="font-mono">VITE_SUPABASE_URL</code> 与{' '}
              <code className="font-mono">VITE_SUPABASE_ANON_KEY</code>,并按{' '}
              <code className="font-mono">app/backend/migrations/0001_init.sql</code> 执行数据库迁移。
            </p>
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-[12px] text-[var(--text-2)] mb-1">
              邮箱
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-10 px-3 rounded-[6px] bg-[var(--panel)] border border-[var(--line)] text-[14px] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-[12px] text-[var(--text-2)] mb-1">
              密码
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-10 px-3 rounded-[6px] bg-[var(--panel)] border border-[var(--line)] text-[14px] outline-none focus:border-[var(--accent)]"
            />
          </div>

          {error && <p className="text-[12px] text-[var(--danger)]">{error}</p>}
          {notice && <p className="text-[12px] text-[var(--success)]">{notice}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full h-10 rounded-[6px] btn-primary text-[13px] font-medium disabled:opacity-45"
          >
            {busy ? '处理中…' : mode === 'signin' ? '登录' : '注册'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
          className="mt-4 text-[12px] text-[var(--text-2)] hover:text-[var(--text)]"
        >
          {mode === 'signin' ? '没有账号?去注册' : '已有账号?去登录'}
        </button>
      </div>
    </div>
  );
}
