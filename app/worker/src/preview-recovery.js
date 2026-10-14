import { validateRuntimeScript } from './workspace-policy.js';
import { Workspace } from './workspace.js';
import { logger } from './logger.js';
import { redact } from './telemetry.js';

export async function savedPreviewHealthy(url) {
 if(!url||!url.startsWith('https://'))return false;
 try {return (await fetch(url,{method:'GET',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(6000)})).ok;}
 catch {return null;}
}

/** 只唤醒保存的沙箱，绝不走 ensure/create，也不调用模型。 */
export async function recoverExistingPreview(provider, id, phase, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), { existingUrl = null, probeUrl = savedPreviewHealthy } = {}) {
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
  await provider.ensurePreviewPlatform?.(id);
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
  // Signing again changes the browser origin. A healthy saved URL owns the existing app data.
  if (existingUrl && (await probeUrl(existingUrl)) !== false) {
    logger.info('preview.url_reused', { sandboxId: id });
    return existingUrl;
  }
  const url = await provider.previewUrl(id, 5173);
  logger.info('preview.url_resolved', { sandboxId: id });
  if (!url || !url.startsWith('https://')) throw new Error('没有取得有效的预览地址');
  return url;
}

export async function processOnePreviewRecovery({ rpc, getSandbox, workerId, getProject = async () => null, inspectWriter = async () => ({terminal:false}), workspaceFactory = (args) => new Workspace(args) }) {
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
    const project = await getProject(job.project_id, job.user_id);
    if (project && (project.id!==job.project_id || project.user_id!==job.user_id || project.sandbox_id!==job.sandbox_id))
      throw new Error('预览项目或沙箱绑定已变化');
    const provider = getSandbox();
    provider.bindOwner?.(job.sandbox_id, { projectId: job.project_id, userId: job.user_id });
    const workspace = workspaceFactory({ rpc, projectId: job.project_id, workerId, executionId: job.execution_id, sandbox: provider, sandboxId: job.sandbox_id });
    if (workspace.read) await workspace.read();
    if (workspace.state?.writer) {
      const old=workspace.state.writer;
      await workspace.reconcileRuntime({inspect:writer=>inspectWriter(job.project_id,job.user_id,writer),
        quiesce:async()=>{
          // Stop -> Stopped clears old command memory. Never infer quiescence from a lease alone.
          await update('checking');
          const current=await provider.client.get(job.sandbox_id);
          const state=String(current.state).toLowerCase();
          if(state==='started')await provider.client.stop(current);
          else if(!['stopped','archived'].includes(state))throw new Error('沙箱仍在状态转换，不能释放写入资格');
          const stopped=await provider.client.get(job.sandbox_id);
          if(!['stopped','archived'].includes(String(stopped.state).toLowerCase()))throw new Error('未确认旧进程停止');
          await provider.client.start(stopped,180);
          provider.cache.delete(job.sandbox_id);
          return {stopped:true};
        }});
      logger.info('workspace.reconciled',{projectId:job.project_id,kind:old.kind,proof:'stopped_lifecycle_and_exact_manifest'});
    }
    await workspace.initialize({ reconcilePending: false, wake: () => provider.ensure(job.sandbox_id, { projectId: job.project_id, userId: job.user_id, allowRecreate: false }) });
    if (workspace.manifest) validateRuntimeScript(workspace.manifest, 'dev');
    const url = await workspace.runtime('preview', () => recoverExistingPreview(provider, job.sandbox_id, update, undefined, { existingUrl: project?.preview_url }));
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
