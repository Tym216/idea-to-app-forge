import { sourceError } from './managed-source.js';

/** A claimed successor may exclude only its own, DB-confirmed live task from activity. */
export function runtimeTaskStatus(tasks, writer, resumingTask = null, now = Date.now()) {
  const current = resumingTask && tasks.find(t => t.id === resumingTask.id);
  if (resumingTask && (!current || current.status !== 'running'
      || current.execution_id !== resumingTask.execution_id
      || current.execution_id === writer.execution_id
      || !(Date.parse(current.lease_until) > now)))
    throw sourceError('LEASE_LOST', '恢复执行尚无有效租约，未停止沙箱或释放旧 writer');
  const old = writer.task_id && tasks.find(t => t.id === writer.task_id);
  const superseded = current && old?.id === current.id;
  const terminal = old ? superseded || ['failed','cancelled','succeeded','succeeded_with_warnings'].includes(old.status)
    : writer.kind === 'preview' && typeof writer.result?.error === 'string';
  return { terminal: Boolean(terminal),
    active: tasks.some(t => t.id !== current?.id && ['queued','running','paused'].includes(t.status)),
    leaseActive: tasks.some(t => t.execution_id === writer.execution_id && Date.parse(t.lease_until) > now) };
}

/** Lifecycle proof stops old command memory; source equality is checked by Workspace afterwards. */
export async function quiesceRuntimeSandbox(provider, id, checkLease) {
  await checkLease();
  const current = await provider.client.get(id);
  const state = String(current.state).toLowerCase();
  if (state === 'started') { await checkLease(); await provider.client.stop(current); }
  else if (!['stopped','archived'].includes(state))
    throw sourceError('WORKSPACE_UNCERTAIN', '沙箱仍在状态转换，未释放旧运行资格');
  const stopped = await provider.client.get(id);
  if (!['stopped','archived'].includes(String(stopped.state).toLowerCase()))
    throw sourceError('WORKSPACE_UNCERTAIN', '未确认旧进程停止');
  await checkLease();
  await provider.client.start(stopped,180);
  await checkLease();
  provider.cache.delete(id);
  return {stopped:true};
}

export async function reconcileBuildWorkspace({workspace,provider,task,inspectWriter,checkLease}) {
  const writer = workspace.state.writer;
  if (!writer) return;
  // Source mutations, legacy and install-drift keep their existing dedicated reconciliation.
  if (['mutation','materialize','legacy'].includes(writer.kind) || writer.changeset_id)
    return workspace.reconcile();
  await workspace.reconcileRuntime({
    inspect: async retained => { await checkLease(); return inspectWriter(task.project_id,task.user_id,retained,{resumingTask:task}); },
    quiesce: () => quiesceRuntimeSandbox(provider,workspace.sandboxId,checkLease),
  });
}
