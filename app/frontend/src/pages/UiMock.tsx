import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Message, Plan, PlanFeedback, Project, ProjectFile, Stage, Task } from '@/lib/supabase';
import { WorkspaceView, type WorkspaceActions } from '@/components/WorkspaceView';

/**
 * UI 模拟页(仅用于界面验证,不连接 Supabase / 模型 / Daytona)。
 * /ui-mock?state=empty|plan|running|failed|success
 */
const now = Date.now();
const iso = (s: number) => new Date(now - s * 1000).toISOString();
const PROJECT: Project = { id: 'p', user_id: 'u', name: '待办清单', description: '', framework: 'react', sandbox_id: null, preview_url: null, status: 'idle', created_at: iso(900), updated_at: iso(10) };

const stages = (m: Record<string, Stage['status']>, notes: Record<string, string> = {}): Stage[] =>
  [['understand', '理解需求'], ['read', '读取现有代码'], ['edit', '修改代码'], ['build', '安装依赖并构建'], ['start', '启动应用'], ['preview', '预览就绪']].map(
    ([key, label]) => ({ key, label, status: m[key] ?? 'pending', note: notes[key] ?? '' })
  );

const task = (o: Partial<Task>): Task => ({
  id: 'a1b2c3d4-0000-0000-0000-000000000000', project_id: 'p', mode: 'build', prompt: '', status: 'running', phase: 'react', plan: [], steps: [],
  error: null, fix_rounds: 0, tool_steps: 0, created_at: iso(120), started_at: iso(118), updated_at: iso(3), finished_at: null,
  plan_id: 'pl2', plan_version: 2, round: 3, kind: 'new', retry_of: null, resumes: 0, last_tool: null, last_tool_ms: null, ...o,
});

const OLD_FAIL = task({ id: 'old00000-0000', status: 'failed', round: 1, mode: 'build', finished_at: iso(3000), error: JSON.stringify({ code: 'FIX_LIMIT_REACHED', reason: '构建多次修复仍失败', next: '', raw: '' }) });

const planV = (version: number, status: Plan['status'], questions = true): Plan => ({
  id: `pl${version}`, project_id: 'p', version, kind: 'plan', status, source_task_id: null, approved_at: status === 'approved' ? iso(100) : null, created_at: iso(200 - version * 10),
  content: {
    understanding: '一个在桌面和手机都好用的个人待办清单:快速添加、勾选完成、删除。',
    scope: ['添加任务', '勾选完成 / 取消完成', '删除任务', '空状态与全部完成提示'],
    steps: ['确定单列布局与设计 token', '实现任务列表与输入栏', '实现完成与删除交互', '构建并启动预览'],
    design: '清爽浅色,单一强调色,居中单列',
    questions: questions
      ? [
          { id: 'q1', question: '任务需要在刷新后保留吗?', options: ['保存在浏览器本地', '不需要保留'], recommended: '保存在浏览器本地' },
          { id: 'q2', question: '是否需要截止日期?', options: ['需要', '暂不需要'], recommended: '暂不需要' },
        ]
      : [],
  },
});

function scenario(state: string) {
  const msgs: Message[] = [
    { id: 'm0', project_id: 'p', role: 'user', content: '做一个待办清单', meta: {}, task_id: 'old00000-0000', created_at: iso(3100) },
    { id: 'm1', project_id: 'p', role: 'assistant', content: '任务失败:构建多次修复仍失败', meta: { error: true }, task_id: 'old00000-0000', created_at: iso(3000) },
  ];
  const fb: PlanFeedback[] = [{ id: 'f1', plan_id: 'pl1', plan_version: 1, content: '删除前不需要确认', answers: { q1: '保存在浏览器本地' }, created_at: iso(150) }];
  const file: ProjectFile = { id: 'f', project_id: 'p', path: 'src/App.tsx', content: 'export default function App() {\n  return <main>待办</main>;\n}\n', updated_at: iso(5) };
  switch (state) {
    case 'empty':
      return { tasks: [], plans: [], fb: [], msgs: [], files: [], project: PROJECT };
    case 'plan':
      return {
        tasks: [task({ mode: 'plan', status: 'succeeded', phase: 'done', plan: [], round: 2, plan_version: 1, finished_at: iso(60) }), OLD_FAIL],
        plans: [planV(2, 'draft'), planV(1, 'superseded', false)], fb, msgs, files: [], project: PROJECT,
      };
    case 'running':
      return {
        tasks: [task({ phase: 'fixing', fix_rounds: 1, plan: stages({ understand: 'done', read: 'done', edit: 'done', build: 'running' }, { build: '构建失败,正在修复' }),
          steps: [{ tool: 'read_file', phase: 'read_file', observation: 'src/App.tsx', at: iso(60), ok: true, ms: 210 }, { tool: 'build', phase: 'build', observation: 'exitCode=1 TS2304', at: iso(20), ok: false, ms: 18200 }] }), OLD_FAIL],
        plans: [planV(2, 'approved')], fb, msgs, files: [file], project: PROJECT,
      };
    case 'failed':
      return {
        tasks: [task({ status: 'failed', phase: 'error', last_tool: 'build', last_tool_ms: 312000, finished_at: iso(5),
          plan: stages({ understand: 'done', read: 'done', edit: 'done', build: 'failed' }),
          error: JSON.stringify({ code: 'TASK_TIMEOUT', reason: '任务超时(15 分钟)。最后执行 build,已耗时 312 秒', next: '可「恢复任务」沿用已写代码继续,或缩小需求后「新建任务」', raw: 'Error: TASK_TIMEOUT\n    at Timeout._onTimeout (index.js:40)' }) }), OLD_FAIL],
        plans: [planV(2, 'approved')], fb, msgs, files: [file], project: PROJECT,
      };
    default:
      return {
        tasks: [task({ status: 'succeeded', phase: 'done', finished_at: iso(5), plan: stages({ understand: 'done', read: 'done', edit: 'done', build: 'done', start: 'done', preview: 'done' }) }), OLD_FAIL],
        plans: [planV(2, 'approved')], fb, msgs: [...msgs, { id: 'm2', project_id: 'p', role: 'assistant' as const, content: '待办应用已构建并启动。', meta: {}, task_id: 'a1b2c3d4-0000-0000-0000-000000000000', created_at: iso(5) }],
        files: [file], project: { ...PROJECT, preview_url: '/ui-mock-preview.html' },
      };
  }
}

export default function UiMock() {
  const [params] = useSearchParams();
  const state = params.get('state') || 'plan';
  const base = useMemo(() => scenario(state), [state]);
  const [data, setData] = useState(base);
  const [log, setLog] = useState('');
  const actions: WorkspaceActions = {
    approve: async (id, v) => {
      setLog(`approve ${id} v${v}`);
      setData((d) => ({ ...d, plans: d.plans.map((p) => (p.id === id ? { ...p, status: 'approved' } : p)), tasks: [task({ status: 'queued', phase: 'queued', plan_version: v, round: 3 }), ...d.tasks] }));
      return task({});
    },
    revise: async (id, v, text, answers) => {
      setLog(`revise ${id} v${v}: ${text} ${JSON.stringify(answers)}`);
      setData((d) => ({ ...d, fb: [...d.fb, { id: `f${d.fb.length + 2}`, plan_id: id, plan_version: v, content: text, answers, created_at: new Date().toISOString() }], tasks: [task({ mode: 'plan', status: 'queued', phase: 'queued', round: 3 }), ...d.tasks] }));
      return task({});
    },
    retry: async (id, kind) => {
      setLog(`retry ${id} ${kind}`);
      return task({});
    },
  };
  return (
    <>
      <div className="fixed top-1 left-1/2 -translate-x-1/2 z-50 pointer-events-none rounded-[6px] bg-[#111111] text-white text-[11px] px-2 py-1 opacity-80" data-testid="mock-banner">
        UI 模拟数据 · 非真实模型/Daytona{log ? ` · ${log}` : ''}
      </div>
      <WorkspaceView
        project={data.project} messages={data.msgs} files={data.files} tasks={data.tasks} plans={data.plans} feedback={data.fb}
        error="" onBack={() => undefined} onExport={() => undefined}
        onSubmit={async (text, mode) => { setLog(`submit ${mode}: ${text}`); return true; }}
        onChanged={() => undefined} memory={null} actions={actions}
      />
    </>
  );
}
