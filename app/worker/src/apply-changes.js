import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { AgentStopError } from './build-progress.js';

export const hashContent = (content) => content == null ? null : createHash('sha256').update(content).digest('hex');
const missing = (error) => [error?.status, error?.statusCode, error?.response?.status].includes(404)
  || /file not found|ENOENT|no such file|^not found$/i.test(String(error?.message || error));

export function validateChanges(args, { maxFiles = 8, maxBytes = 131072 } = {}) {
  if (!args || Object.keys(args).some((key) => !['changes', 'after'].includes(key))) throw new Error('apply_changes 只接受 changes / after');
  if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > maxFiles) throw new Error(`changes 需 1-${maxFiles} 项`);
  const after = args.after ?? 'none';
  if (!['none', 'build'].includes(after)) throw new Error('after 只支持 none / build');
  const seen = new Set();
  let bytes = 0;
  const changes = args.changes.map((change) => {
    if (!change || change.operation !== 'write' || Object.keys(change).some((key) => !['operation', 'path', 'content'].includes(key))) throw new Error('首版只支持完整 write');
    if (typeof change.path !== 'string' || !change.path || /[\x00-\x1f\\]/.test(change.path)
      || path.posix.isAbsolute(change.path) || /^[A-Za-z]:|^~/.test(change.path) || change.path.split('/').includes('..')) throw new Error('文件路径必须位于项目内');
    const normalized = path.posix.normalize(change.path);
    if (normalized === '.' || normalized.length > 200 || normalized.endsWith('/')) throw new Error('无效文件路径');
    if (['node_modules', '.git', '.forge-verify'].some((dir) => normalized.split('/').includes(dir))) throw new Error('不能修改运行环境或内部目录');
    if (seen.has(normalized)) throw new Error(`重复路径 ${normalized}`);
    seen.add(normalized);
    if (typeof change.content !== 'string') throw new Error('write 必须包含完整 content 字符串');
    bytes += Buffer.byteLength(change.content, 'utf8');
    return { operation: 'write', path: normalized, content: change.content };
  });
  if (bytes > maxBytes) throw new Error(`批量内容超过 ${maxBytes} 字节`);
  return { changes, after };
}

async function readCurrent(sandbox, sandboxId, filePath) {
  try { return await sandbox.readFile(sandboxId, filePath); }
  catch (error) { if (missing(error)) return null; throw error; }
}

/** Immutable intent + resolution events, persisted through the existing lease-checked steps JSON. */
export function pendingChanges(rows) {
  const intents = new Map();
  const resolved = new Set();
  for (const row of rows) for (const step of row.steps || []) {
    if (step.tool !== 'change_journal' || !step.operation_id) continue;
    if (step.event === 'intent') intents.set(step.operation_id, { ...step, source_task_id: row.id });
    if (step.event === 'resolved') resolved.add(step.operation_id);
  }
  return [...intents.values()].filter((item) => !resolved.has(item.operation_id));
}

export async function applyChanges({ task, sandbox, sandboxId, changes, deps, beforeWrite, invalidate, onWriteSuccess = async () => {} }) {
  const operations = [];
  const files = await deps.listFiles(task.project_id);
  for (const [index, change] of changes.entries()) {
    const operationId = `${task.execution_id || task.id}:${randomUUID()}:${index}`;
    // No side effect before baseline reads and durable intent are confirmed.
    const databaseContent = files.find((file) => file.path === change.path)?.content ?? null;
    const sandboxContent = await readCurrent(sandbox, sandboxId, change.path);
    await deps.checkLease();
    const intent = {
      tool: 'change_journal', event: 'intent', phase: 'edit', operation_id: operationId,
      sandbox_id: sandboxId, path: change.path, content: change.content,
      intended_hash: hashContent(change.content), before_database_hash: hashContent(databaseContent),
      before_sandbox_hash: hashContent(sandboxContent), observation: `准备写入 ${change.path}`,
    };
    await deps.appendStep(task, intent);
    await beforeWrite(index, change.path);
    invalidate(); // Before mutation; a timeout cannot leave prior verification valid.
    try {
      await sandbox.writeFile(sandboxId, change.path, change.content);
      await deps.checkLease();
      await deps.upsertFile(task, change.path, change.content);
      await deps.checkLease();
      await deps.appendStep(task, { tool: 'change_journal', event: 'resolved', phase: 'edit', operation_id: operationId,
        path: change.path, state: 'succeeded', observation: `已确认写入 ${change.path}` });
      await onWriteSuccess(index, change);
      operations.push({ index, kind: 'write_file', path: change.path, status: 'succeeded' });
    } catch (error) {
      const stopped = new AgentStopError('CHANGE_UNCERTAIN', `写入 ${change.path} 未确认；恢复前必须核对沙箱和数据库，不自动重试`);
      stopped.operations = [...operations, { index, kind: 'write_file', path: change.path, status: 'uncertain' },
        ...changes.slice(index + 1).map((item, offset) => ({ index: index + offset + 1, kind: 'write_file', path: item.path, status: 'not_run' }))];
      stopped.cause = error;
      if (error?.code === 'LEASE_LOST' || task.aborted) throw error;
      throw stopped;
    }
  }
  return { status: 'succeeded', operations };
}

/** Reconcile before hydration or ANY model call; never replay an uncertain sandbox mutation. */
export async function reconcileChanges({ task, sandbox, deps }) {
  const rows = await deps.listChangeJournals(task.project_id);
  const pending = pendingChanges(rows);
  for (const item of pending) {
    await deps.checkLease();
    let sandboxHash;
    try { sandboxHash = hashContent(await readCurrent(sandbox, item.sandbox_id, item.path)); }
    catch (error) { throw new AgentStopError('CHANGE_UNCERTAIN', `${item.path} 的原沙箱无法核对；未覆盖文件或创建新沙箱`); }
    const files = await deps.listFiles(task.project_id);
    const databaseHash = hashContent(files.find((file) => file.path === item.path)?.content ?? null);
    let state;
    if (sandboxHash === item.intended_hash && [item.before_database_hash, item.intended_hash].includes(databaseHash)) {
      if (databaseHash !== item.intended_hash) await deps.upsertFile(task, item.path, item.content);
      state = 'succeeded';
    } else if (sandboxHash === item.before_sandbox_hash && databaseHash === item.before_database_hash) state = 'not_applied';
    else throw new AgentStopError('CHANGE_UNCERTAIN', `${item.path} 与操作前/预期版本不一致；保留现状，需人工核对`);
    await deps.checkLease();
    await deps.appendStep(task, { tool: 'change_journal', event: 'resolved', phase: 'reconciling', operation_id: item.operation_id,
      path: item.path, state, observation: `已核对 ${item.path}：${state}` });
  }
  return pending.length;
}
