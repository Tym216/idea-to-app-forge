import { useEffect, useState } from 'react';
import { Brain, Check, Pencil, Trash2, X } from 'lucide-react';
import type { Memory, MemorySuggestion } from '@/lib/supabase';
import {
  deleteMemory, listMemories, listMemorySuggestions, resolveMemorySuggestion, setMemoryEnabled, upsertMemory,
} from '@/lib/data';

type Scope = 'user' | 'project';
const SECTION: Record<Scope, { title: string; hint: string }> = {
  user: { title: '我的默认偏好', hint: '适用于你的所有项目。停用后不会用于之后的生成。' },
  project: { title: '当前项目约定', hint: '只用于本项目,删除项目时一并删除。' },
};

/** 记忆面板:分开管理全局默认偏好与当前项目约定;对话中的偏好只以建议出现,确认后才保存。 */
export function MemoryPanel({ projectId }: { projectId: string }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [suggestions, setSuggestions] = useState<MemorySuggestion[]>([]);
  const [editing, setEditing] = useState<{ id?: string; scope: Scope; key: string; value: string } | null>(null);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const [m, s] = await Promise.all([listMemories(projectId), listMemorySuggestions(projectId)]);
      setMemories(m);
      setSuggestions(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || !editing.key.trim() || !editing.value.trim()) return;
    const { scope, key, value } = editing;
    void act(async () => {
      await upsertMemory({ scope, key: key.trim(), value: value.trim(), projectId });
      setEditing(null);
    });
  };

  const renderSection = (scope: Scope) => {
    const list = memories.filter((m) => m.scope === scope);
    return (
      <section className="space-y-1.5" aria-label={SECTION[scope].title}>
        <div className="flex items-center justify-between">
          <h3 className="text-[12px] font-semibold text-[var(--text)]">{SECTION[scope].title}</h3>
          <button type="button" onClick={() => setEditing({ scope, key: '', value: '' })} className="text-[12px] text-[var(--accent)] !bg-transparent">
            添加
          </button>
        </div>
        <p className="text-[11px] text-[var(--text-2)]">{SECTION[scope].hint}</p>
        {list.length === 0 && <p className="text-[12px] text-[var(--text-2)]">暂无。</p>}
        <ul className="space-y-1">
          {list.map((m) => {
            const off = scope === 'user' && m.enabled === false;
            return (
              <li key={m.id} className="flex items-start gap-2 text-[12px]">
                <span className={`flex-1 ${off ? 'text-[var(--text-2)] line-through' : ''}`}>
                  <span className="font-medium">{m.key}</span>:{m.value}
                  {off && <span className="ml-1 no-underline text-[11px]">(已停用)</span>}
                </span>
                {scope === 'user' && (
                  <button type="button" onClick={() => act(() => setMemoryEnabled(m.id, off))} className="shrink-0 text-[11px] text-[var(--accent)] !bg-transparent">
                    {off ? '重新启用' : '停用'}
                  </button>
                )}
                <button type="button" aria-label={`编辑 ${m.key}`} onClick={() => setEditing({ id: m.id, scope, key: m.key, value: m.value })}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] border border-[var(--line)] !bg-transparent">
                  <Pencil className="h-3 w-3 text-[var(--text-2)]" />
                </button>
                <button type="button" aria-label={`删除 ${m.key}`} onClick={() => act(() => deleteMemory(m.id))}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] border border-[var(--line)] hover:border-[var(--danger)] !bg-transparent">
                  <Trash2 className="h-3 w-3 text-[var(--text-2)]" />
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    );
  };

  return (
    <details className="border-t border-[var(--line)] p-3 space-y-3">
      <summary className="flex items-center gap-2 text-[12px] font-medium text-[var(--text-2)] cursor-pointer">
        <Brain className="h-3.5 w-3.5" aria-hidden />
        偏好与项目约定({memories.length}){suggestions.length > 0 && ` · ${suggestions.length} 条建议待确认`}
      </summary>

      <div className="max-h-[260px] overflow-auto space-y-3">
        {suggestions.length > 0 && (
          <section className="space-y-1 rounded-[6px] border border-[var(--line)] p-2" aria-label="偏好建议">
            <h3 className="text-[12px] font-semibold">保存为默认偏好?</h3>
            <p className="text-[11px] text-[var(--text-2)]">从本项目对话中发现,确认后才会用于你的其他项目。</p>
            {suggestions.map((s) => (
              <div key={s.id} className="flex items-start gap-2 text-[12px]">
                <span className="flex-1"><span className="font-medium">{s.key}</span>:{s.value}</span>
                <button type="button" aria-label="保存为默认偏好" onClick={() => act(() => resolveMemorySuggestion(s.id, true))}
                  className="grid h-6 w-6 place-items-center rounded-[6px] border border-[var(--line)] !bg-transparent">
                  <Check className="h-3 w-3 text-[var(--success)]" />
                </button>
                <button type="button" aria-label="不保存" onClick={() => act(() => resolveMemorySuggestion(s.id, false))}
                  className="grid h-6 w-6 place-items-center rounded-[6px] border border-[var(--line)] !bg-transparent">
                  <X className="h-3 w-3 text-[var(--text-2)]" />
                </button>
              </div>
            ))}
          </section>
        )}
        {renderSection('user')}
        {renderSection('project')}
      </div>

      {editing && (
        <form onSubmit={save} className="space-y-2">
          <p className="text-[12px] text-[var(--text-2)]">{editing.id ? '编辑' : '添加'}到「{SECTION[editing.scope].title}」</p>
          <input aria-label="名称" value={editing.key} disabled={!!editing.id} onChange={(e) => setEditing({ ...editing, key: e.target.value })} placeholder="名称,例如:界面语言"
            className="w-full h-8 px-2 rounded-[6px] bg-[var(--panel)] border border-[var(--line)] text-[12px] outline-none focus:border-[var(--accent)]" />
          <input aria-label="内容" value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} placeholder="内容,例如:界面文字使用中文"
            className="w-full h-8 px-2 rounded-[6px] bg-[var(--panel)] border border-[var(--line)] text-[12px] outline-none focus:border-[var(--accent)]" />
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setEditing(null)} className="h-8 px-3 rounded-[6px] border border-[var(--line)] text-[12px] !bg-transparent">取消</button>
            <button type="submit" className="h-8 px-3 rounded-[6px] btn-primary text-[12px]">保存</button>
          </div>
        </form>
      )}
      {error && <p className="text-[12px] text-[var(--danger)]">{error}</p>}
    </details>
  );
}
