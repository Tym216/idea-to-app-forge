import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from './config.js';
import { currentExecution, assertExecutionActive } from './execution-control.js';

export function stateError(operation, error) {
  const result = new Error(`Supabase ${operation} 失败: ${error.message}`);
  result.code = /fetch failed|network|timeout|abort/i.test(error.message || '') ? 'SUPABASE_NETWORK' : 'SUPABASE_STATE';
  return result;
}

/** 使用 service_role 的服务端客户端,绕过 RLS,因此所有写入都必须显式带 user_id 归属校验。 */
export const admin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  global: { fetch: (url, options = {}) => fetch(url, {
    ...options,
    signal: AbortSignal.any([AbortSignal.timeout(10000), ...[options.signal, currentExecution()?.signal].filter(Boolean)]),
  }) },
  auth: { persistSession: false, autoRefreshToken: false },
  // Node 20 无原生 WebSocket,显式提供实现
  realtime: { transport: WebSocket },
});

/** 原子领取一个任务:租约 + 同项目互斥 + 重复执行保护(由 SQL 函数保证)。 */
export async function claimTask() {
  const { data, error } = await admin.rpc('ita_claim_task', {
    p_worker_id: config.workerId,
    p_lease_seconds: config.leaseSeconds,
  });
  if (error) throw new Error(`claimTask failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * 执行上下文:taskId → 本次领取的 execution_id。
 * 每次领取/接管数据库都会生成新 execution_id,所有 Worker 写入 RPC 都精确匹配它,
 * 因此同一 worker_id 的旧执行(超时后被重新领取)也无法再写入。
 */
const executions = new Map();
export function setExecution(taskId, executionId) {
  if (executionId) executions.set(taskId, executionId);
  else executions.delete(taskId);
}
export function executionOf(taskId) {
  const context = currentExecution();
  if (context?.taskId === taskId) {
    assertExecutionActive();
    return context.executionId;
  }
  return executions.get(taskId) ?? null;
}

export async function heartbeat(taskId) {
  const { data, error } = await admin.rpc('ita_heartbeat_task', {
    p_task_id: taskId,
    p_worker_id: config.workerId,
    p_execution_id: executionOf(taskId),
    p_lease_seconds: config.leaseSeconds,
  });
  if (error) throw stateError('心跳续期', error);
  if (data !== true) throw new LeaseLostError(taskId);
}

/** 租约失效:旧执行必须立即中止,不得继续写入。 */
export class LeaseLostError extends Error {
  constructor(taskId) {
    super(`LEASE_LOST: 任务 ${taskId} 的租约已失效或已被接管,本执行已中止,不再写入`);
    this.name = 'LeaseLostError';
    this.code = 'LEASE_LOST';
  }
}

/** 任务写入统一走 ita_worker_update_task:数据库校验 worker_id + running + 租约未过期。 */
export async function updateTask(taskId, patch) {
  const { data, error } = await admin.rpc('ita_worker_update_task', {
    p_task_id: taskId,
    p_worker_id: config.workerId,
    p_execution_id: executionOf(taskId),
    p_patch: patch,
  });
  if (error) throw stateError('任务状态写回', error);
  if (data !== true) throw new LeaseLostError(taskId);
}

/** 非任务表写入(文件/消息/项目/快照)之前校验租约。 */
export async function ensureLease(taskId, executionId = executionOf(taskId)) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await admin.rpc('ita_worker_check_lease', {
      p_task_id: taskId,
      p_worker_id: config.workerId,
      p_execution_id: executionId,
    });
    if (!error) {
      if (data !== true) throw new LeaseLostError(taskId);
      return;
    }
    const failure = stateError('执行许可检查', error);
    if (failure.code !== 'SUPABASE_NETWORK' || attempt === 1) throw failure;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assertExecutionActive();
  }
}

export async function appendStep(task, step) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  steps.push({ ...step, at: new Date().toISOString() });
  task.steps = steps;
  const patch = { steps, phase: step.phase || task.phase, tool_steps: task.tool_steps };
  if (step.tool && !['design', 'plan', 'resume', 'sandbox', 'llm', 'llm_parse_error'].includes(step.tool)) {
    patch.last_tool = step.tool;
    if (Number.isFinite(step.ms)) patch.last_tool_ms = Math.round(step.ms);
  }
  if (Array.isArray(task.plan)) patch.plan = task.plan;
  await updateTask(task.id, patch);
  return steps;
}

export async function savePlan(task, kind, content) {
  const { data, error } = await admin.rpc('ita_worker_save_plan', {
    p_task_id: task.id,
    p_worker_id: config.workerId,
    p_execution_id: executionOf(task.id),
    p_kind: kind,
    p_content: content,
  });
  if (error) {
    if (/LEASE_LOST/.test(error.message)) throw new LeaseLostError(task.id);
    throw new Error(`savePlan failed: ${error.message}`);
  }
  return Array.isArray(data) ? data[0] : data;
}

/** 新一轮 Plan 可以读取上一版已批准的验收定义，避免用户重述全部需求。 */
export async function getLatestPlan(projectId) {
  const { data, error } = await admin.from('ita_plans').select('*')
    .eq('project_id', projectId).order('version', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`getLatestPlan failed: ${error.message}`);
  return data;
}

/** 阻止在新计划出现后恢复仍绑定旧验收定义的任务。 */
export async function getLatestPlanVersion(projectId) {
  const { data, error } = await admin.from('ita_plans').select('version')
    .eq('project_id', projectId).order('version', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`getLatestPlanVersion failed: ${error.message}`);
  return data?.version ?? 0;
}

export async function getPlan(planId, projectId) {
  const { data, error } = await admin
    .from('ita_plans')
    .select('*')
    .eq('id', planId)
    .eq('project_id', projectId)
    .single();
  if (error) throw new Error(`getPlan failed: ${error.message}`);
  return data;
}

/** 该项目截至指定版本的全部计划反馈(按时间顺序)。 */
export async function listFeedback(projectId, upToVersion) {
  const { data, error } = await admin
    .from('ita_plan_feedback')
    .select('plan_version, content, answers, created_at')
    .eq('project_id', projectId)
    .lte('plan_version', upToVersion)
    .order('created_at');
  if (error) throw new Error(`listFeedback failed: ${error.message}`);
  return data || [];
}

export async function addMessage(task, role, content, meta = {}) {
  await ensureLease(task.id);
  const { error } = await admin.from('ita_messages').insert({
    project_id: task.project_id,
    user_id: task.user_id,
    task_id: task.id,
    role,
    content,
    meta,
  });
  if (error) throw new Error(`addMessage failed: ${error.message}`);
}

export async function getProject(projectId, userId) {
  const { data, error } = await admin
    .from('ita_projects')
    .select('*')
    .eq('id', projectId)
    .eq('user_id', userId) // 高权限操作仍校验项目归属
    .single();
  if (error) throw new Error(`getProject failed: ${error.message}`);
  return data;
}

export async function updateProject(projectId, userId, patch, taskId) {
  if (taskId) await ensureLease(taskId);
  const { error } = await admin
    .from('ita_projects')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .eq('user_id', userId);
  if (error) throw new Error(`updateProject failed: ${error.message}`);
}

export async function listFiles(projectId) {
  const { data, error } = await admin
    .from('ita_files')
    .select('path, content, version')
    .eq('project_id', projectId)
    .eq('deleted', false)
    .order('path');
  if (error) throw new Error(`listFiles failed: ${error.message}`);
  return data || [];
}

/** Project-scoped immutable change events, including resolutions written by later tasks. */
export async function listChangeJournals(projectId) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await admin.from('ita_tasks').select('id,steps')
      // The SDK serializes JS arrays as PostgreSQL arrays, not JSONB arrays.
      .eq('project_id', projectId).contains('steps', JSON.stringify([{ tool: 'change_journal' }]))
      .order('created_at').order('id').range(offset, offset + 99);
    if (error) throw stateError('修改记录读取', error);
    rows.push(...(data || []));
    if (!data || data.length < 100) return rows;
  }
}

export async function upsertFile(task, path, content) {
  await ensureLease(task.id);
  const { error } = await admin.from('ita_files').upsert(
    {
      project_id: task.project_id,
      user_id: task.user_id,
      path,
      content,
      deleted: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project_id,path' }
  );
  if (error) throw new Error(`upsertFile failed: ${error.message}`);
}

export async function deleteFile(task, path) {
  await ensureLease(task.id);
  const { error } = await admin
    .from('ita_files')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('project_id', task.project_id)
    .eq('path', path);
  if (error) throw new Error(`deleteFile failed: ${error.message}`);
}

/** 完整代码快照,Sandbox 丢失后可据此恢复。 */
export async function saveSnapshot(task, label) {
  await ensureLease(task.id);
  const files = await listFiles(task.project_id);
  const { error } = await admin.from('ita_snapshots').insert({
    project_id: task.project_id,
    user_id: task.user_id,
    task_id: task.id,
    label,
    files,
  });
  if (error) throw new Error(`saveSnapshot failed: ${error.message}`);
  return files.length;
}
