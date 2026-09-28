import { useSession } from '@/hooks/useSession';
import Auth from './Auth';
import Projects from './Projects';

/** 根路由:未登录显示登录页,已登录显示项目列表。 */
export default function Index() {
  const { session, loading } = useSession();

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg)] grid place-items-center">
        <p className="font-mono text-[12.5px] text-[var(--text-2)]">正在恢复会话…</p>
      </div>
    );
  }

  return session ? <Projects /> : <Auth />;
}
