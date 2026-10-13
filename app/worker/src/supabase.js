import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { assertWorkerEnvironment } from './environment.js';
import { config } from './config.js';
import { redact } from './telemetry.js';
import { currentExecution, assertExecutionActive } from './execution-control.js';

export function stateError(operation, error, response = {}) {
  // Preserve bounded, sanitized diagnostic fields; never copy raw headers or request body.
  const safe = (value) => redact(String(value ?? '').replaceAll(config.supabaseServiceRoleKey || '\0', '[REDACTED_KEY]'), 240);
  const detail = String(error?.details || '');
  const causeMatch = /Caused by:\s*([A-Za-z]*Error):\s*([^\n]+)/.exec(detail);
  const causeCode = /\(([A-Z][A-Z0-9_]+)\)\s*$/.exec(causeMatch?.[2] || '');
  const status = Number(response?.status || error?.status || error?.code);
  const evidence = {
    name: safe(error?.name), code: safe(error?.code), message: safe(error?.message),
    causeName: causeMatch ? safe(causeMatch[1]) : null,
    causeCode: causeCode ? safe(causeCode[1]) : null,
    causeMessage: causeMatch ? safe(causeMatch[2].replace(/\s*\([A-Z][A-Z0-9_]+\)\s*$/, '')) : null,
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    requestId: safe(response?.requestId || error?.requestId) || null,
    phase: response?.phase || 'request_or_response_unconfirmed',
  };
  const result = new Error('Supabase ' + operation + ' 失败: ' + evidence.message);
  result.code = /fetch failed|network|timeout|abort/i.test(evidence.message) ? 'SUPABASE_NETWORK' : 'SUPABASE_STATE';
  result.evidence = evidence;
  return result;
}

/** 使用 service_role 的服务端客户端,绕过 RLS,因此所有写入都必须显式带 user_id 归属校验。 */
let client, clientIdentity;
function getClient() {
  const identity = JSON.stringify(assertWorkerEnvironment());
  if (clientIdentity && clientIdentity !== identity) throw new Error('ENVIRONMENT_ISOLATION: client identity changed; restart with explicit config');
  clientIdentity = identity;
  return client ||= createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  global: { fetch: (url, options = {}) => fetch(url, {
    ...options,
    signal: AbortSignal.any([AbortSignal.timeout(10000), ...[options.signal, currentExecution()?.signal].filter(Boolean)]),
  }) },
  auth: { persistSession: false, autoRefreshToken: false },
  // Node 20 无原生 WebSocket,显式提供实现
  realtime: { transport: WebSocket },
});
}
// Lazy creation keeps offline mocks offline; every actual client creation is guarded.
export const admin = {
  rpc(...args) { return getClient().rpc(...args); },
  from(...args) { return getClient().from(...args); },
  get auth() { return getClient().auth; },
};

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

const HEARTBEAT_RETRY_DELAY_MS = 500;
const HEARTBEAT_REQUEST_TIMEOUT_MS = 10000;
const HEARTBEAT_SAFETY_MS = 2000;

/** Only one transport retry, while the last confirmed lease still covers the whole request. */
export async function heartbeat(taskId, { executionId = executionOf(taskId), confirmedLeaseUntil, signal, onEvent } = {}) {
  const active = () => {
    signal?.throwIfAborted();
    if (executionOf(taskId) !== executionId) throw new LeaseLostError(taskId);
  };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    active();
    onEvent?.({ event: 'attempt', attempt, executionId });
    const { data, error, status } = await admin.rpc('ita_heartbeat_task', {
      p_task_id: taskId,
      p_worker_id: config.workerId,
      p_execution_id: executionId,
      p_lease_seconds: config.leaseSeconds,
    });
    active();
    if (!error) {
      if (data !== true) throw new LeaseLostError(taskId);
      onEvent?.({ event: 'success', attempt, executionId });
      return;
    }
    const failure = stateError('心跳续期', error, { status });
    const eligible = failure.code === 'SUPABASE_NETWORK' || [429, 502, 503, 504].includes(failure.evidence.httpStatus);
    const deadline = typeof confirmedLeaseUntil === 'number' ? confirmedLeaseUntil : Date.parse(confirmedLeaseUntil);
    if (attempt === 2 || !eligible || !Number.isFinite(deadline)
      || Date.now() + HEARTBEAT_RETRY_DELAY_MS + HEARTBEAT_REQUEST_TIMEOUT_MS + HEARTBEAT_SAFETY_MS >= deadline) throw failure;
    onEvent?.({ event: 'retry', attempt, executionId, code: failure.code, httpStatus: failure.evidence.httpStatus });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', cancelled); resolve(); }, HEARTBEAT_RETRY_DELAY_MS);
      const cancelled = () => { clearTimeout(timer); reject(signal.reason); };
      if (signal?.aborted) cancelled();
      else signal?.addEventListener('abort', cancelled, { once: true });
    });
  }
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



export async function completedCheckpoint(task) {
  const { data, error } = await admin.from('ita_snapshots').select('id,verify_evidence').eq('project_id', task.project_id)
    .eq('task_id', task.id).eq('completion_key', `${task.id}:checkpoint`).maybeSingle();
  if (error) throw stateError('完成记录核对', error);
  return data;
}

/** Read-only preflight; never claim a task to test migration/function availability. */
export async function checkWorkspaceSchema(client = admin) {
  const reads = [
    ['ita_projects', 'workspace_revision,workspace_state,workspace_hash,workspace_epoch,workspace_writer,workspace_build,workspace_verify,checkpoint_id'],
    ['ita_changesets', 'id,base_revision,target_hash,status,submission_fingerprint,submission_basis'],
    ['ita_snapshots', 'kind,workspace_revision,code_hash,completion_key,version_number,parent_checkpoint_id'],
    ['ita_tasks', 'base_workspace_revision,context_workspace_revision,operation,requested_changeset_id'],
    ['ita_preview_recoveries','ready_revision,ready_hash'],
  ];
  const results = await Promise.all(reads.map(([table, columns]) => client.from(table).select(columns, { head: true }).limit(1)));
  for (let i = 0; i < results.length; i++) if (results[i].error) throw stateError(`工作区/Demo 迁移 0006–0009 (${reads[i][0]})`, results[i].error);
  const { error } = await client.rpc('ita_workspace_read', {
    p_project_id: '00000000-0000-0000-0000-000000000000', p_task_id: '00000000-0000-0000-0000-000000000000',
    p_worker_id: config.workerId, p_execution_id: '00000000-0000-0000-0000-000000000000',
  });
  if (!error || error.code !== 'P0001' || !error.message.includes('LEASE_LOST')) throw stateError('工作区 RPC/0006 授权', error || { message: '自检未返回预期的拒绝结果' });
}

export async function getRequestedChangeSet(task) {
  await ensureLease(task.id);
  const { data, error } = await admin.from('ita_changesets').select('*').eq('id', task.requested_changeset_id)
    .eq('project_id', task.project_id).eq('user_id', task.user_id).eq('task_id', task.id).single();
  if (error) throw stateError('User Apply submission', error);
  return data;
}
