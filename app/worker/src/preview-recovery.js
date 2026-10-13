import { validateRuntimeScript } from './workspace-policy.js';
import { Workspace } from './workspace.js';
import { logger } from './logger.js';
import { redact } from './telemetry.js';

/** 只唤醒保存的沙箱，绝不走 ensure/create，也不调用模型。 */
export async function recoverExistingPreview(provider, id, phase, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  await phase('checking');
  const sandbox = await provider.client.get(id);
  const state = String(sandbox.state || '').toLowerCase();
  if (state !== 'started') {
    if (state !== 'stopped' && state !== 'archived') throw new Error(`沙箱状态为 ${state || '未知'}，请稍后重试`);
    await phase('starting');
    await provider.client.start(sandbox, 180);
  }
  provider.cache.delete(id);
  await phase('server');
  await provider.configureIdle(sandbox);
  const ready = async () => {
    const r = await provider.exec(id, 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/ || true', { timeoutMs: 10000 });
    return /^2\d\d$/.test(r.stdout.trim());
  };
  if (!await ready()) {
    // HTTP 错误时不重启已有服务，避免把运行中的错误页误判为没有进程。
    if (await provider.isPortListening(id, 5173)) throw new Error('预览服务已运行，但页面未返回成功状态；请查看应用日志');
    await provider.startBackground(id, 'npm run --ignore-scripts dev -- --host 0.0.0.0 --port 5173 --strictPort');
    let up = false;
    for (let i = 0; i < 20; i++) { await sleep(2000); if (await ready()) { up = true; break; } }
    if (!up) throw new Error('开发服务未就绪；代码保留，请重试或查看沙箱日志');
  }
  await phase('checking');
  const url = await provider.previewUrl(id, 5173);
  if (!url || !url.startsWith('https://')) throw new Error('没有取得有效的预览地址');
  return url;
}

export async function processOnePreviewRecovery({ rpc, getSandbox, workerId, workspaceFactory = (args) => new Workspace(args) }) {
  const { data, error } = await rpc('ita_claim_preview_recovery', { p_worker_id: workerId });
  if (error) throw new Error(`preview claim: ${error.message}`);
  const job = Array.isArray(data) ? data[0] : data;
  if (!job?.project_id) return null;
  let readyBasis;
  const update = async (phase, url = null, error = null) => {
    const result = await rpc('ita_update_preview_recovery', {
      p_project_id: job.project_id, p_worker_id: workerId, p_execution_id: job.execution_id,
      p_phase: phase, p_url: url, p_error: error,
      ...(phase === 'ready' ? { p_revision: readyBasis?.revision, p_hash: readyBasis?.hash } : {}),
    });
    if (result.error) throw new Error(`preview save: ${result.error.message}`);
    if (result.data !== true) { const e = new Error('预览恢复许可已失效'); e.code = 'LEASE_LOST'; throw e; }
  };
  try {
    const provider = getSandbox();
    provider.bindOwner?.(job.sandbox_id, { projectId: job.project_id, userId: job.user_id });
    const workspace = workspaceFactory({ rpc, projectId: job.project_id, workerId, executionId: job.execution_id, sandbox: provider, sandboxId: job.sandbox_id });
    await workspace.initialize({ reconcilePending: false, wake: () => provider.ensure(job.sandbox_id, { projectId: job.project_id, userId: job.user_id, allowRecreate: false }) });
    if (workspace.manifest) validateRuntimeScript(workspace.manifest, 'dev');
    const url = await workspace.runtime('preview', () => recoverExistingPreview(provider, job.sandbox_id, update));
    readyBasis = { revision: workspace.state?.revision, hash: workspace.manifest?.code_hash };
    await update('ready', url);
    logger.info('preview.recovered', { projectId: job.project_id, sandboxId: job.sandbox_id });
    return { status: 'ready' };
  } catch (e) {
    if (e.code === 'LEASE_LOST') return { status: 'stale' };
    const reason = redact(e.message || String(e), 250);
    await update('failed', null, reason);
    logger.warn('preview.recovery_failed', { projectId: job.project_id, reason });
    return { status: 'failed' };
  }
}
