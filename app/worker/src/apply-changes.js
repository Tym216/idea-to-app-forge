import { createHash } from 'node:crypto';
import path from 'node:path';

export const hashContent = (content) => content == null ? null : createHash('sha256').update(content).digest('hex');


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
