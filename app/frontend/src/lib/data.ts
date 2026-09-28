import JSZip from 'jszip';
import { supabase } from './supabase';
import type { FeedbackCategory, Memory, MemorySuggestion, Message, Plan, PlanFeedback, PreviewRecovery, Project, ProjectFile, Task, TaskFeedback } from './supabase';

export async function requestPreviewRecovery(projectId: string): Promise<PreviewRecovery> {
  const { data, error } = await supabase.rpc('ita_request_preview_recovery', { p_project_id: projectId });
  if (error) throw rpcError(error);
  return (Array.isArray(data) ? data[0] : data) as PreviewRecovery;
}

export async function getPreviewRecovery(projectId: string): Promise<PreviewRecovery | null> {
  const { data, error } = await supabase.from('ita_preview_recoveries').select('*').eq('project_id', projectId).maybeSingle();
  if (error) throw rpcError(error);
  return data as PreviewRecovery | null;
}

/** 前端只做读取与「提交任务」,任务的推进完全由服务端 Worker 负责。 */

export async function getUser() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function listProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('ita_projects')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data as Project[];
}

export async function createProject(name: string, description: string): Promise<Project> {
  const user = await getUser();
  if (!user) throw new Error('请先登录');
  // 只提交允许的业务字段:sandbox_id / preview_url / status 是 Worker 运行态字段,
  // 数据库层对 authenticated 未授予这些列的写权限,触发器也会强制置为默认值。
  const { data, error } = await supabase
    .from('ita_projects')
    .insert({ user_id: user.id, name, description })
    .select()
    .single();
  if (error) throw error;
  return data as Project;
}

/** 仅允许修改名称/描述/框架,运行态字段由 Worker 维护。 */
export async function updateProjectMeta(
  id: string,
  patch: { name?: string; description?: string; framework?: string }
): Promise<Project> {
  const { data, error } = await supabase.from('ita_projects').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data as Project;
}

export async function getProject(id: string): Promise<Project> {
  const { data, error } = await supabase.from('ita_projects').select('*').eq('id', id).single();
  if (error) throw error;
  return data as Project;
}

/** 两阶段删除:只提交删除请求,由服务端 Worker 清理沙箱后再删除全部数据;重复调用/失败重试安全。 */
export async function deleteProject(id: string) {
  const { error } = await supabase.rpc('ita_request_project_delete', { p_project_id: id, p_request_id: crypto.randomUUID() });
  if (error) throw error;
}

export async function listMessages(projectId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from('ita_messages')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at');
  if (error) throw error;
  return data as Message[];
}

export async function listFiles(projectId: string): Promise<ProjectFile[]> {
  const { data, error } = await supabase
    .from('ita_files')
    .select('*')
    .eq('project_id', projectId)
    .eq('deleted', false)
    .order('path');
  if (error) throw error;
  return data as ProjectFile[];
}

export async function getActiveTask(projectId: string): Promise<Task | null> {
  const tasks = await listTasks(projectId, 1);
  return tasks[0] ?? null;
}

/** 最近的任务(新→旧),用于区分当前任务与历史失败轮次。 */
export async function listTasks(projectId: string, limit = 20): Promise<Task[]> {
  const { data, error } = await supabase
    .from('ita_tasks')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as Task[]) ?? [];
}

export async function listPlans(projectId: string): Promise<Plan[]> {
  const { data, error } = await supabase
    .from('ita_plans')
    .select('*')
    .eq('project_id', projectId)
    .order('version', { ascending: false });
  if (error) throw error;
  return (data as Plan[]) ?? [];
}

export async function listPlanFeedback(projectId: string): Promise<PlanFeedback[]> {
  const { data, error } = await supabase
    .from('ita_plan_feedback')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at');
  if (error) throw error;
  return (data as PlanFeedback[]) ?? [];
}

function rpcError(error: { message: string }): Error {
  if (/PLAN_VERSION_STALE/.test(error.message)) return new Error('计划已更新,请审阅最新版本后再操作。');
  if (/PROJECT_BUSY|ita_tasks_active_unique/.test(error.message)) return new Error('该项目已有任务，请等待完成，或继续/结束已暂停的任务。');
  return new Error(error.message);
}
const one = <T,>(data: unknown) => (Array.isArray(data) ? data[0] : data) as T;

/** 批准并构建:绑定正在查看的版本;数据库保证重复点击返回同一任务。 */
export async function approvePlan(planId: string, version: number): Promise<Task> {
  const { data, error } = await supabase.rpc('ita_approve_plan', { p_plan_id: planId, p_version: version });
  if (error) throw rpcError(error);
  return one<Task>(data);
}

export async function revisePlan(planId: string, version: number, feedback: string, answers: Record<string, string>): Promise<Task> {
  const { data, error } = await supabase.rpc('ita_revise_plan', {
    p_plan_id: planId,
    p_version: version,
    p_feedback: feedback,
    p_answers: answers,
  });
  if (error) throw rpcError(error);
  return one<Task>(data);
}

/** new:新建一轮任务(保留原失败记录);resume:恢复原任务(沿用已写代码与步骤)。 */
export async function retryTask(taskId: string, kind: 'new' | 'resume'): Promise<Task> {
  const { data, error } = await supabase.rpc('ita_retry_task', { p_task_id: taskId, p_kind: kind });
  if (error) throw rpcError(error);
  return one<Task>(data);
}

/**
 * 提交任务:仅写入一行 queued 记录。
 * 关闭页面后 Worker 仍会领取并继续推进,刷新后通过轮询读回状态。
 */
export async function submitTask(projectId: string, prompt: string, mode: 'plan' | 'build'): Promise<Task> {
  const user = await getUser();
  if (!user) throw new Error('请先登录');

  const { error: msgError } = await supabase.from('ita_messages').insert({
    project_id: projectId,
    user_id: user.id,
    role: 'user',
    content: prompt,
    meta: { mode },
  });
  if (msgError) throw msgError;

  // 只提交这 4 个业务字段:数据库层对 authenticated 仅授予这些列的 INSERT 权限,
  // 且 BEFORE INSERT 触发器会强制清洗所有执行态字段,客户端无法伪造 status/租约/计数。
  const { data, error } = await supabase
    .from('ita_tasks')
    .insert({ project_id: projectId, user_id: user.id, prompt, mode })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') throw new Error('该项目已有正在执行的任务,请等待完成后再提交。');
    throw error;
  }
  return data as Task;
}

/** 受控取消:客户端对 ita_tasks 没有 UPDATE 权限,只能通过该 RPC 取消本人任务。 */
export async function cancelTask(taskId: string): Promise<Task> {
  const { data, error } = await supabase.rpc('ita_cancel_task', { p_task_id: taskId });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) as Task;
}

export async function pauseTask(taskId: string): Promise<Task> {
  const { data, error } = await supabase.rpc('ita_pause_task', { p_task_id: taskId });
  if (error) throw rpcError(error);
  return one<Task>(data);
}

export async function resumeTask(taskId: string): Promise<Task> {
  const { data, error } = await supabase.rpc('ita_resume_task', { p_task_id: taskId });
  if (error) throw rpcError(error);
  return one<Task>(data);
}

export async function listMemories(projectId: string): Promise<Memory[]> {
  const { data, error } = await supabase
    .from('ita_memories')
    .select('id, scope, key, value, project_id, enabled')
    .or(`project_id.eq.${projectId},project_id.is.null`)
    .order('scope');
  if (error) throw error;
  return data as Memory[];
}

export async function upsertMemory(input: {
  scope: 'user' | 'project';
  key: string;
  value: string;
  projectId: string;
}) {
  // 通过 RPC 在单条语句内完成 upsert,避免「先删后插」中途失败丢失原记忆。
  // scope 与 project_id 的对应关系、项目归属均由函数内部强制校验。
  const { error } = await supabase.rpc('ita_upsert_memory', {
    p_scope: input.scope,
    p_key: input.key,
    p_value: input.value,
    p_project_id: input.scope === 'project' ? input.projectId : null,
    p_weight: 1,
  });
  if (error) throw error;
}

export async function deleteMemory(id: string) {
  const { error } = await supabase.from('ita_memories').delete().eq('id', id);
  if (error) throw error;
}

/** 将生成应用的源码导出为 ZIP。 */
export async function exportProjectZip(project: Project, files: ProjectFile[]) {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content);
  }
  zip.file('README.md', `# ${project.name}\n\n${project.description}\n\n由 Forge 生成。\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`);
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${project.name.replace(/[^\w-]+/g, '-') || 'app'}.zip`;
  link.click();
  URL.revokeObjectURL(url);
}

export async function setMemoryEnabled(id: string, enabled: boolean) {
  const { error } = await supabase.rpc('ita_set_memory_enabled', { p_memory_id: id, p_enabled: enabled, p_request_id: crypto.randomUUID() });
  if (error) throw error;
}

export async function listMemorySuggestions(projectId: string): Promise<MemorySuggestion[]> {
  const { data, error } = await supabase
    .from('ita_memory_suggestions')
    .select('id, key, value, status, created_at')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as MemorySuggestion[];
}

export async function resolveMemorySuggestion(id: string, accept: boolean) {
  const { error } = await supabase.rpc('ita_resolve_memory_suggestion', { p_id: id, p_accept: accept, p_request_id: crypto.randomUUID() });
  if (error) throw error;
}

export async function submitTaskFeedback(taskId: string, category: FeedbackCategory, note: string): Promise<TaskFeedback> {
  const { data, error } = await supabase.rpc('ita_submit_task_feedback', { p_task_id: taskId, p_category: category, p_note: note });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) as TaskFeedback;
}

export async function listTaskFeedback(taskId: string): Promise<TaskFeedback[]> {
  const { data, error } = await supabase
    .from('ita_task_feedback')
    .select('id, task_id, execution_id, category, note, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as TaskFeedback[];
}
