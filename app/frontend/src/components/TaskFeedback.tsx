import { useEffect, useState } from 'react';
import { Flag } from 'lucide-react';
import type { FeedbackCategory, Task, TaskFeedback as Feedback } from '@/lib/supabase';
import { listTaskFeedback, submitTaskFeedback } from '@/lib/data';

const CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: 'missing_feature', label: '功能缺失' },
  { value: 'preview_broken', label: '预览不可用' },
  { value: 'stuck', label: '生成卡住' },
  { value: 'design_mismatch', label: '设计不符' },
  { value: 'other', label: '其他' },
];
const labelOf = (c: FeedbackCategory) => CATEGORIES.find((x) => x.value === c)?.label ?? c;

/** 已完成或失败任务的「结果有问题」入口;只有项目所有者可提交与查看(数据库强制)。 */
export function TaskFeedback({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>('missing_feature');
  const [note, setNote] = useState('');
  const [items, setItems] = useState<Feedback[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listTaskFeedback(task.id).then(setItems).catch(() => setItems([]));
  }, [task.id]);

  if (task.status !== 'succeeded' && task.status !== 'failed') return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await submitTaskFeedback(task.id, category, note);
      setItems(await listTaskFeedback(task.id));
      setNote('');
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 text-[12px] text-[var(--text-2)] hover:text-[var(--text)] !bg-transparent">
        <Flag className="h-3.5 w-3.5" aria-hidden /> 结果有问题
      </button>
      {items.length > 0 && (
        <p className="text-[11px] text-[var(--text-2)]">已反馈:{items.map((i) => labelOf(i.category)).join('、')}</p>
      )}
      {open && (
        <form onSubmit={submit} className="space-y-2 rounded-[6px] border border-[var(--line)] p-2">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="问题类型">
            {CATEGORIES.map((c) => (
              <label key={c.value} className="inline-flex items-center gap-1 text-[12px]">
                <input type="radio" name={`fb-${task.id}`} checked={category === c.value} onChange={() => setCategory(c.value)} />
                {c.label}
              </label>
            ))}
          </div>
          <textarea aria-label="补充说明(可选)" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="补充说明(可选,最多 1000 字)"
            className="w-full min-h-[56px] px-2 py-1 rounded-[6px] bg-[var(--panel)] border border-[var(--line)] text-[12px] outline-none focus:border-[var(--accent)]" />
          {error && <p className="text-[12px] text-[var(--danger)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="h-8 px-3 rounded-[6px] border border-[var(--line)] text-[12px] !bg-transparent">取消</button>
            <button type="submit" disabled={busy} className="h-8 px-3 rounded-[6px] btn-primary text-[12px] disabled:opacity-45">提交反馈</button>
          </div>
        </form>
      )}
    </div>
  );
}
