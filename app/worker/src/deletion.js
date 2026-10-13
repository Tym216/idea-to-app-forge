import { logger } from './logger.js';
import { redact } from './telemetry.js';

/**
 * 项目删除第二阶段(服务端):领取删除任务 → 只按该项目保存的 sandbox_id 删除 Daytona 沙箱
 * → 成功(或沙箱已不存在)后由数据库在同一事务内删除项目全部数据;失败则项目保持可见并标记 delete_failed。
 * 依赖注入 { rpc, sandbox } 以便离线测试。
 */
export async function processOneDeletion({ rpc, getSandbox, workerId, leaseSeconds = 300 }) {
  const { data, error } = await rpc('ita_claim_project_deletion', { p_worker_id: workerId, p_lease_seconds: leaseSeconds });
  if (error) throw new Error(`claimDeletion failed: ${error.message}`);
  const job = Array.isArray(data) ? data[0] : data;
  if (!job?.project_id) return null;

  let ok = true;
  let reason = null;
  if (job.sandbox_id) {
    try {
      const result = await getSandbox().destroy(job.sandbox_id, { projectId: job.project_id, userId: job.user_id });
      logger.info('deletion.sandbox', { projectId: job.project_id, sandboxId: job.sandbox_id, existed: result?.existed !== false });
    } catch (e) {
      ok = false;
      reason = `沙箱清理失败:${redact(e?.message || e, 200)}`;
      logger.warn('deletion.sandbox_failed', { projectId: job.project_id, error: reason });
    }
  }
  const done = await rpc('ita_complete_project_deletion', {
    p_project_id: job.project_id, p_worker_id: workerId, p_attempts: job.attempts, p_ok: ok, p_error: reason, p_request_id: null,
  });
  if (done.error) throw new Error(`completeDeletion failed: ${done.error.message}`);
  const status = Array.isArray(done.data) ? done.data[0] : done.data;
  logger.info('deletion.finished', { projectId: job.project_id, status, attempts: job.attempts });
  return { projectId: job.project_id, status };
}

/**
 * 孤儿沙箱核对(管理员):只有带本平台 forge_project_id 标签、且该项目在数据库中确认不存在的沙箱才判为孤���;
 * 无标签(旧版本创建)一律归为「归属未知」,永不自动删除。不依据创建时间判断。
 */
export function classifySandboxes(sandboxes, existingProjectIds) {
  const existing = new Set(existingProjectIds);
  const report = { inUse: [], orphan: [], unknown: [] };
  for (const sb of sandboxes) {
    const pid = sb.labels?.forge_project_id;
    if (!pid) report.unknown.push(sb);
    else if (existing.has(pid)) report.inUse.push(sb);
    else report.orphan.push(sb);
  }
  return report;
}
