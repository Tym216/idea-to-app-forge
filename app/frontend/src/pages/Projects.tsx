import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, LogOut, User } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { Project } from '@/lib/supabase';
import { createProject, deleteProject, listProjects } from '@/lib/data';

export default function Projects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      setProjects(await listProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!idea.trim()) return;
    setBusy(true);
    setError('');
    try {
      const name = idea.trim().slice(0, 40);
      const project = await createProject(name, idea.trim());
      navigate(`/workspace/${project.id}?prompt=${encodeURIComponent(idea.trim())}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const [confirming, setConfirming] = useState<Project | null>(null);
  const [typed, setTyped] = useState('');
  const [deleteError, setDeleteError] = useState('');

  const remove = async () => {
    if (!confirming || typed !== 'delete') return;
    setDeleteError('');
    try {
      await deleteProject(confirming.id);
      setConfirming(null);
      setTyped('');
      await refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    }
  };

  // 删除由服务端异步完成,有删除中的项目时定时刷新
  useEffect(() => {
    if (!projects.some((p) => p.deletion_state === 'deleting')) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-[var(--line)]">
        <div className="mx-auto max-w-[1120px] px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-1 w-8 bg-[var(--accent)]" />
            <span className="text-[14px] font-semibold tracking-[.02em]">FORGE</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-[6px] border border-[var(--line)]" aria-hidden>
              <User className="h-4 w-4 text-[var(--text-2)]" />
            </span>
            <button
              type="button"
              aria-label="退出登录"
              onClick={() => supabase.auth.signOut()}
              className="grid h-8 w-8 place-items-center rounded-[6px] border border-[var(--line)] hover:border-[var(--accent)]"
            >
              <LogOut className="h-4 w-4 text-[var(--text-2)]" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1120px] px-6 py-10">
        <h1 className="text-[20px] leading-7 font-semibold">用一句话描述你想要的应用</h1>
        <p className="text-[13px] text-[var(--text-2)] mt-1">
          提交后由服务端 Worker 持续执行:调用真实大模型生成代码,在 Daytona 沙箱中安装依赖、构建并启动,失败会自动修复重试。
        </p>

        <form onSubmit={create} className="mt-6 flex gap-3">
          <input
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="例如:做一个支持分类和本地存储的待办清单"
            className="flex-1 h-11 px-3 rounded-[6px] bg-[var(--panel)] border border-[var(--line)] text-[14px] outline-none focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            disabled={busy || !idea.trim()}
            className="h-11 px-5 rounded-[6px] btn-primary text-[13px] font-medium disabled:opacity-45 flex items-center gap-2"
          >
            <Plus className="h-4 w-4" />
            {busy ? '创建中…' : '新建项目'}
          </button>
        </form>

        {error && <p className="mt-3 text-[12px] text-[var(--danger)]">{error}</p>}

        <h2 className="mt-10 mb-3 text-[14px] leading-5 font-semibold tracking-[.02em] uppercase text-[var(--text-2)]">
          我的项目
        </h2>

        {loading ? (
          <p className="font-mono text-[12.5px] text-[var(--text-2)]">正在读取…</p>
        ) : projects.length === 0 ? (
          <div className="border border-[var(--line)] rounded-[8px] p-6">
            <p className="text-[13px] text-[var(--text-2)]">还没有项目。在上方输入一句需求即可创建第一个项目。</p>
          </div>
        ) : (
          <ul className="border border-[var(--line)] rounded-[8px] divide-y divide-[var(--line)] overflow-hidden">
            {projects.map((project) => (
              <li key={project.id} className="h-16 px-4 flex items-center justify-between hover:bg-[var(--panel)]">
                <button
                  type="button"
                  disabled={!!project.deletion_state}
                  onClick={() => navigate(`/workspace/${project.id}`)}
                  className="flex-1 text-left disabled:cursor-not-allowed"
                >
                  <div className="text-[14px]">{project.name}</div>
                  {project.deletion_state === 'deleting' ? (
                    <div className="text-[12px] text-[var(--text-2)]">正在删除:清理沙箱与项目数据…</div>
                  ) : project.deletion_state === 'delete_failed' ? (
                    <div className="text-[12px] text-[var(--danger)]">删除未完成,可重试:{project.delete_error}</div>
                  ) : (
                    <div className="text-[12px] text-[var(--text-2)] font-mono">
                      {project.status} · {new Date(project.updated_at).toLocaleString()}
                    </div>
                  )}
                </button>
                <button
                  type="button"
                  disabled={project.deletion_state === 'deleting'}
                  aria-label={project.deletion_state === 'delete_failed' ? `重试删除项目 ${project.name}` : `删除项目 ${project.name}`}
                  onClick={() => { setConfirming(project); setTyped(''); setDeleteError(''); }}
                  className="grid h-8 w-8 place-items-center rounded-[6px] border border-[var(--line)] hover:border-[var(--danger)]"
                >
                  <Trash2 className="h-4 w-4 text-[var(--text-2)]" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      {confirming && (
        <div role="dialog" aria-modal="true" aria-labelledby="del-title" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-[440px] rounded-[8px] border border-[var(--line)] bg-[var(--bg)] p-5 space-y-3">
            <h2 id="del-title" className="text-[15px] font-semibold">删除项目「{confirming.name}」</h2>
            <p className="text-[13px] text-[var(--text-2)]">以下内容将被永久清理,无法恢复:</p>
            <ul className="text-[13px] list-disc pl-5 space-y-0.5">
              <li>该项目的运行环境(Daytona 沙箱)与预览地址</li>
              <li>聊天记录、计划与计划反馈</li>
              <li>任务与执行步骤、结果问题反馈</li>
              <li>代码文件与历史快照</li>
              <li>当前项目约定与待确认的偏好建议</li>
            </ul>
            <p className="text-[12px] text-[var(--text-2)]">保留:你的账号、其他项目,以及「我的默认偏好」。正在运行的任务会立即停止。</p>
            <label className="block text-[12px]">
              请输入小写 <span className="font-mono font-semibold">delete</span> 确认
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="mt-1 w-full h-9 px-2 rounded-[6px] bg-[var(--panel)] border border-[var(--line)] text-[13px] font-mono outline-none focus:border-[var(--accent)]"
              />
            </label>
            {deleteError && <p className="text-[12px] text-[var(--danger)]">{deleteError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirming(null)} className="h-9 px-3 rounded-[6px] border border-[var(--line)] text-[13px] !bg-transparent">
                取消
              </button>
              <button
                type="button"
                disabled={typed !== 'delete'}
                onClick={remove}
                className="h-9 px-3 rounded-[6px] bg-[var(--danger)] text-white text-[13px] disabled:opacity-45"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
