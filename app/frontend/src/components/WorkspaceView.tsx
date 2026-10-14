import {ConversationTimeline} from './ConversationTimeline';
import {getAppVersion} from '@/lib/data';
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
  onRestore?:(id:string,requestId:string,baseRevision:number)=>Promise<ApplyReceipt>;
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
  viewingVersionId?:string|null;
  onViewingVersion?:(id:string|null)=>void;
  checkingWorkspace?:boolean;
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
  const deletablePaths=messages.flatMap(m=>Array.isArray(m.meta?.createdFiles)?m.meta.createdFiles.filter((p):p is string=>typeof p==='string'):[]);
  const workingDraft=!stableWorkspace(project,versions.find(v=>v.id===project?.checkpoint_id)) || activeTask(tasks);
  const [viewed,setViewed]=useState<AppVersion|null>(null);
  const [versionError,setVersionError]=useState('');
  const versionRequest=useRef(0);
  const restoreRequests=useRef(new Map<string,string>());
  const [restorePending,setRestorePending]=useState(false),[restoreNotice,setRestoreNotice]=useState(''),[restoreTaskId,setRestoreTaskId]=useState('');
  const restoreTask=tasks.find(t=>t.id===restoreTaskId);
  const restoreStatus=restoreTask?.status==='succeeded'?'已恢复源码并创建新版本；请查看版本卡片的检查结论。':restoreTask?.status==='failed'?'恢复未完成；已确认的源码保留，可查看任务详情并重试。':restoreTask?.status==='paused'?'恢复已暂停，代码与进度保留。':restoreNotice;
  const restoreBlocked=activeTask(tasks)||project?.workspace_state!=='confirmed'||!!project?.workspace_writer||!!props.recoveryPending||['queued','running'].includes(props.recovery?.status??'')||restorePending;
  const restore=async(v:AppVersion)=>{
   if(!props.onRestore||!project||restoreBlocked)return;
   if(!window.confirm('恢复 App v'+v.version_number+' 到当前工作区？当前源码将被替换，未 Apply 的本地草稿可能过期。历史版本保留；成功后创建新版本，不回滚业务数据。'))return;
   const key=v.id+':'+project.workspace_revision;
   if(!restoreRequests.current.has(key))restoreRequests.current.set(key,crypto.randomUUID());
   setRestorePending(true);setRestoreNotice('');
   try{const receipt=await props.onRestore(v.id,restoreRequests.current.get(key)!,project.workspace_revision??0);
    setRestoreTaskId(receipt.noop?'':receipt.task_id);
    setRestoreNotice(receipt.noop?'当前源码已与该版本一致；未创建新 revision 或版本。':'恢复已提交，Worker 正在应用并检查；完成后才创建新版本。');
    if(!receipt.noop)void viewVersion(null);
   }catch(e){setRestoreNotice(e instanceof Error?e.message:'恢复未提交，请刷新后重试。');}finally{setRestorePending(false);}
  };
  const viewVersion=async(id:string|null)=>{
    const n=++versionRequest.current;
    if(!id||id===project?.checkpoint_id){setViewed(null);setVersionError('');props.onViewingVersion?.(null);pick('code');return;}
    try {const v=await getAppVersion(id);if(v.project_id!==project?.id)throw Error('版本不属于当前项目');
     if(n===versionRequest.current){setViewed(v);setVersionError('');props.onViewingVersion?.(id);pick('code');}
    }catch{if(n===versionRequest.current)setVersionError('版本源码暂时无法读取，请稍后重试。');}
  };
  useEffect(()=>{const id=props.viewingVersionId;if(id&&id!==project?.checkpoint_id&&project)void viewVersion(id);},[props.viewingVersionId,project?.id,project?.checkpoint_id]);
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
              {props.checkingWorkspace&&<p role="status" className="p-3 text-sm">正在确认工作区状态…</p>}
              <ConversationTimeline plans={plans} messages={messages} tasks={tasks} versions={versions} currentId={project?.checkpoint_id}
                onVersion={id=>void viewVersion(id)} onChanged={onChanged}/>
              <details className="px-4 pb-3"><summary>开发者诊断与任务详情</summary>
               <TaskPanel current={current} history={history} onChanged={onChanged} retry={actions.retry}/>
              </details>
              <div ref={bottomRef}/>
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
            <div className={tab==='preview'?'h-full':'hidden'}><PreviewPane checkingWorkspace={props.checkingWorkspace} label={workingDraft ? 'Working Workspace · 正在处理或有未发布修改' : 'Working Workspace · 检查时对应 App v'+versions.find(v=>v.id===project?.checkpoint_id)?.version_number} url={props.previewUrl!==undefined ? props.previewUrl : readyPreview(project,props.recovery) ? props.recovery?.preview_url ?? null : null} state={state}
              recovery={props.recovery?.sandbox_id === project?.sandbox_id && props.recovery?.project_id === project?.id ? props.recovery : null}
              recoveryError={props.recoveryError} recoveryPending={props.recoveryPending} onRecover={props.onRecoverPreview} /></div>
            {versionError&&<p role="alert">{versionError}</p>}
            {restoreStatus&&<p role="status" className="p-2 text-sm">{restoreStatus}</p>}
            {tab==='code'&&<div className="p-2 text-xs border-b"> {viewed?'Version '+viewed.version_number+' · 历史源码只读':'Current · Version '+(versions.find(v=>v.id===project?.checkpoint_id)?.version_number??'—')+(workingDraft?' · 有未发布修改':'')}
              {viewed&&<button className="ml-3" onClick={()=>void viewVersion(null)}>查看 Current</button>}
              {viewed&&props.onRestore&&<button className="ml-3" disabled={restoreBlocked} onClick={()=>void restore(viewed)}>恢复此版本到当前工作区</button>}
            </div>}
            <div className={tab==='code'&&!viewed ? 'h-full' : 'hidden'}><CodeExplorer projectId={project?.id} deletablePaths={deletablePaths} files={files} readonly={!props.onApply}
              revision={project?.workspace_revision ?? 0} task={current ?? undefined}
              blocked={activeTask(tasks) || project?.workspace_state!=='confirmed' || !!project?.workspace_writer || !!props.recoveryPending || ['queued','running'].includes(props.recovery?.status ?? '')}
              onApply={props.onApply}/></div>
            {tab==='code'&&viewed&&<CodeExplorer key={viewed.id} readonly files={viewed.files.map(f=>({...f,id:f.path,project_id:viewed.project_id,updated_at:viewed.created_at}))}/>}
            {tab==='preview'&&viewed&&<p className="p-2 text-xs">历史源码已选中；预览仍是当前工作区。历史运行预览暂不支持。</p>}
            {tab === 'versions' && <VersionsPanel versions={versions} currentId={project?.checkpoint_id} workingDraft={workingDraft} onSelect={id=>void viewVersion(id)} onRestore={props.onRestore?v=>restore(v):undefined} restoreBlocked={restoreBlocked}/>}
          </div>
        </main>
      </div>
    </div>
  );
}
