import { useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [draft, setDraft] = useState('');
  const remaining = todos.filter((t) => !t.done).length;
  const allDone = todos.length > 0 && remaining === 0;

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const title = draft.trim();
    if (!title) return;
    setTodos((list) => [...list, { id: Date.now() + Math.random(), title, done: false }]);
    setDraft('');
  };
  const toggle = (id: number) => setTodos((list) => list.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const remove = (id: number) => setTodos((list) => list.filter((t) => t.id !== id));

  return (
    <main className="page">
      <header className="header">
        <h1>今日待办</h1>
        <p className="muted">记录要做的事,完成后勾选。</p>
      </header>

      <form className="composer" onSubmit={add}>
        <label htmlFor="new-todo" className="sr-only">新任务</label>
        <input
          id="new-todo"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="添加一个任务…"
          autoComplete="off"
        />
        <button type="submit" className="primary" disabled={!draft.trim()} aria-label="添加任务">
          <Plus size={18} aria-hidden /> <span className="btn-text">添加</span>
        </button>
      </form>

      {todos.length === 0 ? (
        <section className="empty" data-testid="empty">
          <h2>还没有任务</h2>
          <p className="muted">在上方输入框写下第一件要做的事。</p>
        </section>
      ) : (
        <ul className="list" aria-label="任务列表">
          {todos.map((t) => (
            <li key={t.id} className={t.done ? 'item done' : 'item'}>
              <button
                type="button"
                className="check"
                role="checkbox"
                aria-checked={t.done}
                aria-label={`标记 ${t.title} ${t.done ? '未完成' : '已完成'}`}
                onClick={() => toggle(t.id)}
              >
                {t.done && <Check size={14} aria-hidden />}
              </button>
              <span className="title">{t.title}</span>
              <button type="button" className="icon danger" aria-label={`删除 ${t.title}`} onClick={() => remove(t.id)}>
                <Trash2 size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {todos.length > 0 && (
        <footer className={allDone ? 'summary all-done' : 'summary'} data-testid="summary">
          {allDone ? '全部完成,干得漂亮!' : `剩余 ${remaining} 项 · 共 ${todos.length} 项`}
        </footer>
      )}
    </main>
  );
}
