import {usePreviewEntry,probePreviewHealth} from '@/lib/previewEntry';
import { previewRecoveryKey, savedPreviewIdentity } from '@/lib/workspaceState';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { AppVersion, CheckpointIdentity, Message, Plan, PlanFeedback, PreviewRecovery, Project, ProjectFile, Task } from '@/lib/supabase';
import {
  exportProjectZip,
  listAppVersions, getCheckpointIdentity,
  submitUserApply, restoreAppVersion,
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
import {useSession} from '@/hooks/useSession';
import {WorkspaceErrorBoundary} from '@/components/WorkspaceErrorBoundary';
import { MemoryPanel } from '@/components/MemoryPanel';

/** 工作区:数据读取与提交;任务由服务端 Worker 推进,前端轮询读取,刷新后状态完整保留。 */
export default function Workspace() {
  const { projectId = '' } = useParams();
  const navigate=useNavigate();
  const [params]=useSearchParams();
  const recover=()=>{const next=new URLSearchParams(params);next.delete('prompt');
   navigate({pathname:'/workspace/'+projectId,search:next.toString()},{replace:true});};
  return <WorkspaceErrorBoundary key={projectId} projectId={projectId} onRecover={recover} onBack={()=>navigate('/')}><ProjectWorkspace projectId={projectId}/></WorkspaceErrorBoundary>;
}
function ProjectWorkspace({projectId}:{projectId:string}) {
  const navigate = useNavigate();
  const {session}=useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  // Preview is read-only and may load before the revision-bracketed editor data.
  const [previewProject,setPreviewProject]=useState<Project|null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [versions,setVersions] = useState<AppVersion[]>([]);
  const [checkpoint,setCheckpoint]=useState<CheckpointIdentity|null>(null);
  const [feedback, setFeedback] = useState<PlanFeedback[]>([]);
  const [error, setError] = useState('');
  const autoSubmitted = useRef(false);
  const refreshRequest=useRef<Promise<void>|null>(null);
  const checkedWriters=useRef(new Set<string>());
  const recoveryRequest=useRef<Promise<void>|null>(null);
  const readFailures=useRef(0);
  const [recovery, setRecovery] = useState<PreviewRecovery | null>(null);
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryPending, setRecoveryPending] = useState(false);

  const recoverPreview = useCallback(() => {
    if(recoveryRequest.current) return recoveryRequest.current;
    const operation=(async()=>{
      setRecoveryError('');
      readFailures.current=0;
      setRecoveryPending(true);
      try {
        // A timed-out submission may already be queued; do not blindly submit another job.
        const job=await requestPreviewRecovery(projectId);
        setRecovery(job);
      } catch(e) {setRecoveryError(e instanceof Error ? e.message : String(e));}
      finally {setRecoveryPending(false);}
    })();
    recoveryRequest.current=operation;
    void operation.then(()=>{if(recoveryRequest.current===operation) recoveryRequest.current=null;});
    return operation;
  },[projectId]);

  const refresh = useCallback(() => {
    if(refreshRequest.current)return refreshRequest.current;
    const operation=(async()=>{
    try {
      const before = await getProject(projectId);
      setPreviewProject(before);
      const [m, f, t, pl, fb, vs, job, cp] = await Promise.all([
        listMessages(projectId), listFiles(projectId), listTasks(projectId),
        listPlans(projectId), listPlanFeedback(projectId), listAppVersions(projectId), getPreviewRecovery(projectId),
        before.checkpoint_id?getCheckpointIdentity(before.checkpoint_id,projectId):Promise.resolve(null),
      ]);
      const p = await getProject(projectId);
      // Monotonic revision brackets the files SELECT; never pair old files with a new edit basis.
      if (before.workspace_revision !== p.workspace_revision || before.workspace_hash !== p.workspace_hash || before.checkpoint_id !== p.checkpoint_id) {
        setError('工作区正在更新，正在同步源码。请稍后重新加载。');
        return;
      }
      setProject(p);
      setPreviewProject(p);
      setRecovery(job);
      setMessages(m);
      setFiles(f);
      setTasks(t);
      setPlans(pl);
      setFeedback(fb);
      setVersions(vs);setCheckpoint(cp);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    })();
    refreshRequest.current=operation;
    void operation.finally(()=>{if(refreshRequest.current===operation)refreshRequest.current=null;});
    return operation;
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  const checkingWorkspace=Boolean(project?.workspace_writer&&!tasks.some(t=>['queued','running','paused'].includes(t.status)));
  const previewSource=previewProject??project;
  const previewIdentity=savedPreviewIdentity(previewSource,tasks,Boolean(previewSource?.checkpoint_id)||files.length>0);
  const currentRecovery=recovery?.sandbox_id===previewSource?.sandbox_id&&recovery?.project_id===previewSource?.id?recovery:null;
  const previewHealthy=usePreviewEntry({identity:previewIdentity,url:previewSource?.preview_url??null,
    pending:recoveryPending||['queued','running'].includes(currentRecovery?.status??''),
    canRecover:previewRecoveryKey(previewSource,tasks,Boolean(previewSource?.checkpoint_id)||files.length>0)!==null,recover:recoverPreview});
  const savedUrl=previewIdentity&&previewHealthy!==false?previewSource?.preview_url??null:null;
  const checkAndRefreshPreview=useCallback(async()=>{
    const url=previewSource?.preview_url;
    if(url&&(await probePreviewHealth(url))===true)return;
    if(!recoveryPending&&!['queued','running'].includes(currentRecovery?.status??''))await recoverPreview();
  },[previewSource?.preview_url,recoveryPending,currentRecovery?.status,recoverPreview]);

  useEffect(()=>{
    if(!checkingWorkspace||!project||previewHealthy!==false||['queued','running'].includes(recovery?.status??''))return;
    const writer=project.workspace_writer as {token?:string;kind?:string};
    if(writer.kind!=='preview')return;
    if(writer.token&&!checkedWriters.current.has(writer.token)){
      checkedWriters.current.add(writer.token);void recoverPreview();
    }
  },[checkingWorkspace,project,recovery?.status,recoverPreview,previewHealthy]);

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
      storageIdentity={session?.user.id&&previewSource?.user_id===session.user.id?{
       environment:import.meta.env.VITE_FORGE_ENVIRONMENT_ID,ref:import.meta.env.VITE_EXPECTED_SUPABASE_PROJECT_REF,
       userId:session.user.id,projectId}:undefined}
      versions={versions}
      checkpoint={checkpoint}
      checkingWorkspace={checkingWorkspace}
      viewingVersionId={searchParams.get('version')}
      onViewingVersion={id=>{const next=new URLSearchParams(searchParams);if(id)next.set('version',id);else next.delete('version');setSearchParams(next,{replace:true});}}
      onApply={async(input)=>{const receipt=await submitUserApply(projectId,input);await refresh();return receipt;}}
      onRestore={async(id,requestId,baseRevision)=>{const receipt=await restoreAppVersion(projectId,id,requestId,baseRevision);await refresh();return receipt;}}
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
      previewUrl={savedUrl}
      recovery={savedUrl&&previewHealthy===true&&currentRecovery?.status==='failed'?null:currentRecovery}
      recoveryError={recoveryError}
      recoveryPending={recoveryPending}
      onRecoverPreview={() => void checkAndRefreshPreview()}
      onUpgradePreview={()=>void recoverPreview()}
      memory={<MemoryPanel projectId={projectId} />}
    />
  );
}
