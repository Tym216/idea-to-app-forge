import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { AppVersion, Message, Plan, PlanFeedback, PreviewRecovery, Project, ProjectFile, Task } from '@/lib/supabase';
import {
  exportProjectZip,
  listAppVersions,
  submitUserApply,
  getProject,
  getPreviewRecovery,
  requestPreviewRecovery,
  listFiles,
  listMessages,
  listPlanFeedback,
  listPlans,
  listTasks,
  submitTask,
} from '@/lib/data';
import { WorkspaceView, type Mode } from '@/components/WorkspaceView';
import { MemoryPanel } from '@/components/MemoryPanel';

/** 工作区:数据读取与提交;任务由服务端 Worker 推进,前端轮询读取,刷新后状态完整保留。 */
export default function Workspace() {
  const { projectId = '' } = useParams();
  return <ProjectWorkspace key={projectId} projectId={projectId}/>;
}
function ProjectWorkspace({projectId}:{projectId:string}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [versions,setVersions] = useState<AppVersion[]>([]);
  const [feedback, setFeedback] = useState<PlanFeedback[]>([]);
  const [error, setError] = useState('');
  const autoSubmitted = useRef(false);
  const autoRecovered = useRef('');
  const readFailures=useRef(0);
  const [recovery, setRecovery] = useState<PreviewRecovery | null>(null);
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryPending, setRecoveryPending] = useState(false);

  const [entryChecked,setEntryChecked] = useState('');
  const recoverPreview = useCallback(async () => {
    setRecoveryError('');
    readFailures.current=0;
    setRecoveryPending(true);
    try {
      let job:PreviewRecovery|null=null;
      for(let attempt=0;attempt<3;attempt++) {
        try { job=await requestPreviewRecovery(projectId);break; }
        catch(e) { if(attempt===2 || !/network|fetch|timeout|503|502/i.test(String(e))) throw e;await new Promise(r=>setTimeout(r,500*(attempt+1))); }
      }
      setRecovery(job);setEntryChecked(projectId);
    }
    catch (e) { setRecoveryError(e instanceof Error ? e.message : String(e)); }
    finally { setRecoveryPending(false); }
  }, [projectId]);

  const refresh = useCallback(async () => {
    try {
      const before = await getProject(projectId);
      const [m, f, t, pl, fb, vs] = await Promise.all([
        listMessages(projectId), listFiles(projectId), listTasks(projectId),
        listPlans(projectId), listPlanFeedback(projectId), listAppVersions(projectId),
      ]);
      const p = await getProject(projectId);
      // Monotonic revision brackets the files SELECT; never pair old files with a new edit basis.
      if (before.workspace_revision !== p.workspace_revision || before.workspace_hash !== p.workspace_hash) {
        setError('工作区正在更新，正在同步源码。请稍后重新加载。');
        return;
      }
      setProject(p);
      setMessages(m);
      setFiles(f);
      setTasks(t);
      setPlans(pl);
      setFeedback(fb);
      setVersions(vs);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!project?.sandbox_id || project.deletion_state || tasks.some((t) => t.mode === 'build' && ['queued', 'running'].includes(t.status))) return;
    const key = [project.id,project.sandbox_id,project.workspace_revision,project.workspace_hash].join(':');
    if (autoRecovered.current === key) return;
    autoRecovered.current = key;
    void recoverPreview();
  }, [project, tasks, recoverPreview]);

  useEffect(() => {
    if (!recovery || !['queued', 'running'].includes(recovery.status)) return;
    const timer = setInterval(() => {
      void getPreviewRecovery(projectId).then((job) => {
        readFailures.current=0;setRecoveryError('');setRecovery(job);
        if (job?.status === 'ready') void refresh();
      }).catch((e) => {readFailures.current++;if(readFailures.current>=3){clearInterval(timer);setRecoveryError(e instanceof Error ? e.message : String(e));}});
    }, 2000);
    return () => clearInterval(timer);
  }, [recovery, projectId, refresh]);

  const submit = useCallback(
    async (text: string, mode: Mode) => {
      setError('');
      try {
        await submitTask(projectId, text, mode);
        await refresh();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [projectId, refresh]
  );

  // 从项目列表带着初始需求进入时,以默认的 Plan 模式提交一次
  useEffect(() => {
    const initial = searchParams.get('prompt');
    if (initial && !autoSubmitted.current) {
      autoSubmitted.current = true;
      setSearchParams({}, { replace: true });
      void submit(initial, 'plan');
    }
  }, [searchParams, setSearchParams, submit]);

  return (
    <WorkspaceView
      key={projectId}
      project={project}
      versions={versions}
      onApply={async(input)=>{const receipt=await submitUserApply(projectId,input);await refresh();return receipt;}}
      messages={messages}
      files={files}
      tasks={tasks}
      plans={plans}
      feedback={feedback}
      error={error}
      onBack={() => navigate('/')}
      onExport={() => project && exportProjectZip(project, files)}
      onSubmit={submit}
      onChanged={refresh}
      recovery={recovery}
      recoveryError={recoveryError}
      recoveryPending={recoveryPending || Boolean(project?.sandbox_id && entryChecked!==projectId)}
      onRecoverPreview={() => void recoverPreview()}
      memory={<MemoryPanel projectId={projectId} />}
    />
  );
}
