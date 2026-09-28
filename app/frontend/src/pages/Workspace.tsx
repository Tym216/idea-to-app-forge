import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Message, Plan, PlanFeedback, PreviewRecovery, Project, ProjectFile, Task } from '@/lib/supabase';
import {
  exportProjectZip,
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [feedback, setFeedback] = useState<PlanFeedback[]>([]);
  const [error, setError] = useState('');
  const autoSubmitted = useRef(false);
  const autoRecovered = useRef('');
  const [recovery, setRecovery] = useState<PreviewRecovery | null>(null);
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryPending, setRecoveryPending] = useState(false);

  const recoverPreview = useCallback(async () => {
    setRecoveryError('');
    setRecoveryPending(true);
    try { setRecovery(await requestPreviewRecovery(projectId)); }
    catch (e) { setRecoveryError(e instanceof Error ? e.message : String(e)); }
    finally { setRecoveryPending(false); }
  }, [projectId]);

  const refresh = useCallback(async () => {
    try {
      const [p, m, f, t, pl, fb] = await Promise.all([
        getProject(projectId),
        listMessages(projectId),
        listFiles(projectId),
        listTasks(projectId),
        listPlans(projectId),
        listPlanFeedback(projectId),
      ]);
      setProject(p);
      setMessages(m);
      setFiles(f);
      setTasks(t);
      setPlans(pl);
      setFeedback(fb);
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
    const key = `${project.id}:${project.sandbox_id}`;
    if (autoRecovered.current === key) return;
    autoRecovered.current = key;
    void recoverPreview();
  }, [project, tasks, recoverPreview]);

  useEffect(() => {
    if (!recovery || !['queued', 'running'].includes(recovery.status)) return;
    const timer = setInterval(() => {
      void getPreviewRecovery(projectId).then((job) => {
        setRecovery(job);
        if (job?.status === 'ready') void refresh();
      }).catch((e) => setRecoveryError(e instanceof Error ? e.message : String(e)));
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
      project={project}
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
      recoveryPending={recoveryPending}
      onRecoverPreview={() => void recoverPreview()}
      memory={<MemoryPanel projectId={projectId} />}
    />
  );
}
