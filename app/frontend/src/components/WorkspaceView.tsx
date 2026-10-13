import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Code2, Download, FileText, Monitor, PanelLeftClose, PanelLeftOpen, Send } from 'lucide-react';
import { activeTask, defaultMode, stableWorkspace, readyPreview } from '@/lib/workspaceState';
import { VersionsPanel } from './VersionsPanel';
import type { ApplyReceipt, EditSubmission } from './CodeExplorer';
import type { AppVersion, Message, Plan, PlanFeedback, PreviewRecovery, Project, ProjectFile, Task } from '@/lib/supabase';
import { approvePlan, retryTask, revisePlan } from '@/lib/data';
import { splitTasks, viewState } from '@/lib/taskView';
import { TaskPanel } from './TaskPanel';
import { PlanPanel } from './PlanPanel';
import { CodeExplorer } from './CodeExplorer';
import { PreviewPane } from './PreviewPane';

export type Mode = 'plan' | 'build';
type Tab = 'plan' | 'preview' | 'code' | 'versions';

export type WorkspaceActions = {
  approve: typeof approvePlan;
  revise: typeof revisePlan;
  retry: typeof retryTask;
};

type Props = {
  project: Project | null;
  versions?:AppVersion[];
  onApply?:(input:EditSubmission)=>Promise<ApplyReceipt>;
  messages: Message[];
  files: ProjectFile[];
  tasks: Task[];
  plans: Plan[];
  feedback: PlanFeedback[];
  error: string;
  onBack: () => void;
  onExport: () => void;
  onSubmit: (text: string, mode: Mode) => Promise<boolean>;
  onChanged: () => void | Promise<void>;
  memory: ReactNode;
  actions?: WorkspaceActions;
  previewUrl?: string | null;
  recovery?: PreviewRecovery | null;
  recoveryError?: string;
  recoveryPending?: boolean;
  onRecoverPreview?: () => void;
};

const TABS: { key: Tab; label: string; icon: typeof FileText }[] = [
  { key: 'plan', label: '计划', icon: FileText },
  { key: 'preview', label: '预览', icon: Monitor },
  { key: 'code', label: '代码', icon: Code2 },
  { key: 'versions', label: 'App Versions', icon: FileText },
];

/**
 * 工作区布局:左侧「需求输入 + 执行进度」,右侧「计划 / 预览 / 代码」。
 * 纯展示组件,数据与操作由页面注入,便于用 fixture 做 UI 模拟验证。
 */
export function WorkspaceView(props: Props) {
  const { project, messages, files, tasks, plans, feedback, error, onBack, onExport, onSubmit, onChanged, memory } = props;
  const actions = props.actions ?? { approve: approvePlan, revise: revisePlan, retry: retryTask };
  const { current, history } = splitTasks(tasks);
  const state = viewState(current);
  const busy = state === 'waiting' || state === 'running' || state === 'paused';
  const [modeChoice,setModeChoice]=useState<Mode|null>(null);
  const mode=modeChoice ?? defaultMode(project);
  const versions=props.versions ?? [];
  const workingDraft=!stableWorkspace(project,versions.find(v=>v.id===project?.checkpoint_id)) || activeTask(tasks);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);
  const draftPlan = plans.find((p) => p.kind === 'plan' && p.status === 'draft');
  const preferred: Tab = current?.mode === 'plan' ? 'plan' : project?.preview_url && current?.mode === 'build' ? 'preview' : draftPlan || plans.length ? 'plan' : 'preview';
  const [tab, setTab] = useState<Tab>(preferred);
  const chosen = useRef(false);
  const previousTaskId = useRef(current?.id);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (previousTaskId.current !== current?.id) {
      previousTaskId.current = current?.id;
      chosen.current = false;
    }
    if (!chosen.current) setTab(preferred);
  }, [current?.id, preferred, draftPlan?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const pick = (t: Tab) => {
    chosen.current = true;
    setTab(t);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || busy || sending) return;
    setSending(true);
    const ok = await onSubmit(prompt.trim(), mode);
    setSending(false);
    if (ok) setPrompt('');
  };

  return (
    <div className="h-[100dvh] flex flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="h-12 px-3 sm:px-4 flex items-center gap-2 border-b border-[var(--line)] bg-[var(--panel)] shrink-0">
        <button type="button" aria-label="返回项目列表" onClick={onBack} className="btn-ghost grid h-8 w-8 place-items-center rounded-[6px]">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)] shrink-0" aria-hidden />
        <span className="text-[14px] font-semibold truncate flex-1 min-w-0">{project?.name ?? '加载中…'}</span>
        <button
          type="button"
          onClick={() => setSideOpen((v) => !v)}
          aria-label={sideOpen ? '收起左侧面板' : '展开左侧面板'}
          className="btn-ghost hidden lg:grid h-8 w-8 place-items-center rounded-[6px]"
        >
          {sideOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
        </button>
        <button
          type="button"
          disabled={files.length === 0 || !project}
          onClick={onExport}
          className="btn-ghost h-8 px-3 rounded-[6px] text-[12px] flex items-center gap-1.5"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">导出工作区源码</span>
        </button>
      </header>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {sideOpen && (
          <aside className="lg:w-[380px] shrink-0 flex flex-col min-h-0 max-h-[55dvh] lg:max-h-none border-b lg:border-b-0 lg:border-r border-[var(--line)] bg-[var(--panel)]">
            <div className="flex-1 min-h-0 overflow-auto">
              <TaskPanel current={current} history={history} onChanged={onChanged} retry={actions.retry} />
              <div className="px-4 pb-3 space-y-2 border-t border-[var(--line)] pt-3" aria-label="对话">
                {messages.length === 0 && <p className="text-[12px] text-[var(--text-2)]">还没有对话。</p>}
                {messages.map((m) => {
                  const round = tasks.find((t) => t.id === m.task_id)?.round;
                  const isErr = Boolean((m.meta as { error?: boolean })?.error);
                  return (
                    <div
                      key={m.id}
                      className={
                        m.role === 'user'
                          ? 'rounded-[8px] bg-[var(--bg)] px-3 py-2 text-[13px] leading-[20px] whitespace-pre-wrap'
                          : `border-l-2 ${isErr ? 'border-[var(--danger)]' : 'border-[var(--line)]'} pl-3 text-[13px] leading-[20px] whitespace-pre-wrap`
                      }
                    >
                      {round && m.task_id !== current?.id && (
                        <span className="block text-[11px] text-[var(--text-2)]">第 {round} 轮{isErr ? ' · 历史失败' : ''}</span>
                      )}
                      {typeof m.meta?.versionNumber === 'number' && <span className="block font-medium">App v{m.meta.versionNumber} 已生成</span>}
                      {m.content}
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>
              {memory}
            </div>

            <form onSubmit={submit} className="p-3 border-t border-[var(--line)] space-y-2 shrink-0 bg-[var(--panel)]">
              <div role="radiogroup" aria-label="提交模式" className="flex items-center gap-1">
                {(['plan', 'build'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setModeChoice(m)}
                    className={`h-7 px-3 rounded-[6px] text-[12px] border ${
                      mode === m ? 'border-[var(--accent)] text-[var(--accent)] bg-[#EEEEFB] font-medium' : 'border-[var(--line)] text-[var(--text-2)]'
                    }`}
                  >
                    {mode === m ? '● ' : ''}
                    {m === 'plan' ? 'Plan' : 'Build'}
                  </button>
                ))}
                <span className="text-[11px] text-[var(--text-2)] ml-1 truncate">
                  {mode === 'plan' ? '先出计划,不改代码' : '直接生成并运行'} · 仅影响下一次提交
                </span>
              </div>
              <div className="flex gap-2">
                <textarea
                  aria-label="需求输入"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
                  }}
                  rows={2}
                  placeholder={busy ? '当前任务执行中,可先写好下一条需求' : '描述需求或修改…(⌘/Ctrl + Enter 提交)'}
                  className="flex-1 min-w-0 rounded-[6px] bg-[var(--panel)] border border-[var(--line)] p-2 text-[14px] resize-none focus:border-[var(--accent)] outline-none"
                />
                <button
                  type="submit"
                  disabled={busy || sending || !prompt.trim()}
                  aria-label={busy ? '当前任务执行中,暂不能提交' : '提交'}
                  className="btn-primary h-10 w-10 shrink-0 grid place-items-center rounded-[6px] self-end"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
              {busy && <p className="text-[11px] text-[var(--text-2)]">{state === 'paused' ? '请先继续或结束已暂停的任务，再提交新需求。' : '同一项目一次只执行一个任务,完成后即可提交。'}</p>}
              {error && <p role="alert" className="text-[12px] text-[var(--danger)]">{error}</p>}
            </form>
          </aside>
        )}

        <main className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div role="tablist" aria-label="工作区视图" className="h-10 px-2 flex items-center gap-1 border-b border-[var(--line)] bg-[var(--panel)] shrink-0 overflow-x-auto">
            {TABS.map(({ key, label, icon: TabIcon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => pick(key)}
                className={`h-8 px-3 rounded-[6px] text-[13px] inline-flex items-center gap-1.5 border-b-2 ${
                  tab === key ? 'border-[var(--accent)] text-[var(--text)] font-medium' : 'border-transparent text-[var(--text-2)]'
                }`}
              >
                <TabIcon className="h-3.5 w-3.5" aria-hidden />
                {label}
                {key === 'plan' && draftPlan ? <span className="text-[11px] text-[var(--accent)]">待审阅</span> : null}
                {key === 'code' ? <span className="text-[11px] text-[var(--text-2)]">{files.length}</span> : null}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0 bg-[var(--panel)]">
            {tab === 'plan' && <PlanPanel plans={plans} feedback={feedback} busy={busy} onChanged={onChanged} actions={actions} />}
            {tab === 'preview' && <PreviewPane label={workingDraft ? 'Working Workspace · 正在处理或有未发布修改' : 'Working Workspace · 检查时对应 App v'+versions.find(v=>v.id===project?.checkpoint_id)?.version_number} url={props.previewUrl!==undefined ? props.previewUrl : readyPreview(project,props.recovery) ? props.recovery?.preview_url ?? null : null} state={state}
              recovery={props.recovery?.sandbox_id === project?.sandbox_id && props.recovery?.project_id === project?.id ? props.recovery : null}
              recoveryError={props.recoveryError} recoveryPending={props.recoveryPending} onRecover={props.onRecoverPreview} />}
            <div className={tab==='code' ? 'h-full' : 'hidden'}><CodeExplorer files={files} readonly={!props.onApply}
              revision={project?.workspace_revision ?? 0} task={current ?? undefined}
              blocked={activeTask(tasks) || project?.workspace_state!=='confirmed' || !!project?.workspace_writer || !!props.recoveryPending || ['queued','running'].includes(props.recovery?.status ?? '')}
              onApply={props.onApply}/></div>
            {tab === 'versions' && <VersionsPanel versions={versions} currentId={project?.checkpoint_id} workingDraft={workingDraft}/>}
          </div>
        </main>
      </div>
    </div>
  );
}
