import { logger } from './logger.js';
import path from 'node:path';
import { redact } from './telemetry.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sourceManifest, sourceDiff, applySourceChanges, sha256, evidenceValid, sourceError } from './managed-source.js';

export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const MARK = '__FORGE_WORKSPACE__';

/** Only private immutable helpers/specs are uploaded directly. Managed writes use the gateway. */
export class SandboxWorkspace {
  constructor(sandbox, sandboxId) { this.sandbox = sandbox; this.id = sandboxId; }
  async setup() {
    if (this.dir) return;
    const { workdir } = await this.sandbox.resolve(this.id);
    this.root = workdir;
    this.dir = `${path.posix.dirname(workdir)}/.forge-workspace-${sha256(workdir).slice(0, 24)}`;
    const check = await this.sandbox.exec(this.id, `test ! -L ${shellQuote(this.dir)} && mkdir -p ${shellQuote(this.dir)} && chmod 700 ${shellQuote(this.dir)} && command -v flock`, { timeoutMs: 20000 });
    if (check.exitCode !== 0 || check.timedOut) throw sourceError('WORKSPACE_ENVIRONMENT', '需要真实的 flock 与普通内部目录；未退回直接上传源码');
    const [source, runner] = await Promise.all([readFile(new URL('./managed-source.js', import.meta.url), 'utf8'), readFile(new URL('./workspace-gateway.mjs', import.meta.url), 'utf8')]);
    const version = sha256(source + runner);
    this.runnerDir = `${this.dir}/helpers-${version}`;
    await this.sandbox.writeFile(this.id, `${this.runnerDir}/managed-source.mjs`, source);
    await this.sandbox.writeFile(this.id, `${this.runnerDir}/run.mjs`, runner);
  }
  async run(mode, writer = {}, values = {}, nonblocking = false) {
    await this.setup();
    const operationId = randomUUID();
    const specPath = `${this.dir}/${operationId}.json`;
    await this.sandbox.writeFile(this.id, specPath, JSON.stringify({ root: this.root, privateDir: this.dir, operation_id: operationId, mode,
      token: writer.token, epoch: writer.epoch, base_hash: writer.base_hash, target_hash: writer.target_hash, ...values }));
    const r = await this.sandbox.exec(this.id, `flock ${nonblocking ? '-n ' : '-w 30 '}${shellQuote(`${this.dir}/lock`)} node ${shellQuote(`${this.runnerDir}/run.mjs`)} ${shellQuote(specPath)}`, { timeoutMs: 60000 });
    if (r.timedOut) throw sourceError('WORKSPACE_UNCERTAIN', 'gateway 未确认结束；没有重放');
    const at = r.stdout.lastIndexOf(MARK);
    if (at < 0) throw sourceError('WORKSPACE_UNCERTAIN', 'gateway 无完整结果或仍持锁');
    let out;
    try { out = JSON.parse(r.stdout.slice(at + MARK.length).split('\n')[0]); } catch { throw sourceError('WORKSPACE_UNCERTAIN', 'gateway 结果被截断或格式不完整'); }
    if (out.error) {
      const conflict = /CONFLICT|SYMLINK|SOURCE_TYPE|FENCE_LOST/.test(out.error);
      const e = sourceError(conflict ? 'WORKSPACE_CONFLICT' : out.operations?.length && out.manifest ? 'WORKSPACE_PARTIAL' : 'WORKSPACE_UNCERTAIN', out.error);
      e.result = { operations: out.operations || [], observed_hash: out.manifest?.code_hash };
      throw e;
    }
    if (r.exitCode !== 0) throw sourceError('WORKSPACE_UNCERTAIN', 'gateway 异常退出');
    return out;
  }
  async scan() { return (await this.run('scan')).manifest; }
}

/** Minimal persistence protocol; RPC timeout never silently falls back to legacy files writes. */
export class Workspace {
  constructor({ rpc, projectId, taskId = null, workerId, executionId, sandbox, sandboxId }) {
    this.rpc = rpc; this.scope = { p_project_id: projectId, p_task_id: taskId, p_worker_id: workerId, p_execution_id: executionId };
    this.gateway = new SandboxWorkspace(sandbox, sandboxId); this.sandboxId = sandboxId;
  }
  async call(name, args = {}) {
    const { data, error } = await this.rpc(name, { ...this.scope, ...args });
    if (error) {
      const match = String(error.message).match(/(?:WORKSPACE|SOURCE|CHECKPOINT|LEASE)_[A-Z_]+/);
      throw sourceError(match?.[0] || (/fetch failed|network|timeout|abort/i.test(error.message) ? 'SUPABASE_NETWORK' : 'SUPABASE_STATE'), `工作区 ${name}: ${error.message}`);
    }
    return Array.isArray(data) ? data[0] : data;
  }
  async read() {
    this.state = await this.call('ita_workspace_read');
    this.manifest = sourceManifest(this.state.files);
    if (this.state.code_hash && this.state.code_hash !== this.manifest.code_hash) throw sourceError('WORKSPACE_CONFLICT', '数据库 manifest 与 revision 不一致');
    return this.state;
  }
  async acquire(kind, changesetId = null) {
    return this.call('ita_workspace_acquire', { p_operation_id: randomUUID(), p_kind: kind, p_sandbox_id: this.sandboxId, p_changeset_id: changesetId });
  }
  async block(writer, error, state = 'uncertain') {
    // A lost lease must leave the retained writer blocking successors, even if this write is rejected.
    await this.call('ita_workspace_result', { p_token: writer.token, p_state: state, p_result: { ...error.result, error: redact(error.message, 500) } }).catch(() => {});
  }
  async initialize({ newSandbox = false, wake = async () => {}, reconcilePending = true } = {}) {
    await this.read();
    if (this.state.writer) {
      if (!reconcilePending) throw sourceError('WORKSPACE_RECONCILE_REQUIRED', '预览恢复不能接续暂停或未确认的源码修改；请先恢复原任务并核对');
      await this.reconcile();
    }
    await this.read();
    const writer = await this.acquire('materialize');
    try {
      await wake();
      const {manifest:actual} = await this.gateway.run('activate_scan', writer);
      if (!newSandbox && actual.code_hash !== this.manifest.code_hash) throw sourceError('WORKSPACE_CONFLICT', '现存沙箱源码与持久化基线不同；保留原内容，需核对');
      // Confirmed identical source needs no rewrite; avoid unnecessary HMR reloads on re-entry.
      if(newSandbox||actual.code_hash!==this.manifest.code_hash)await this.gateway.run('materialize', writer, { files: this.manifest.files, target_hash: this.manifest.code_hash, expected_hash: actual.code_hash });
      await this.call('ita_workspace_finish_operation', { p_token: writer.token, p_hash: this.manifest.code_hash });
      await this.read();
    } catch (e) { await this.block(writer, e, e.code === 'WORKSPACE_CONFLICT' ? 'conflict' : e.code === 'WORKSPACE_PARTIAL' ? 'partial' : 'uncertain'); throw e; }
  }
  async reconcile() {
    const writer = this.state.writer;
    if (writer.kind === 'legacy') throw sourceError('WORKSPACE_LEGACY_QUIESCENCE_REQUIRED', '旧 journal 副作用尚未确认停止；不能用新 token 自动覆盖');
    // Runtime commands are not staged writes. A token cannot prove their processes have exited.
    if (!['mutation', 'materialize'].includes(writer.kind) && !(writer.kind === 'install' && writer.runtime_completed === true && this.state.pending.some((c) => c.id === writer.changeset_id && c.origin === 'install_drift'))) throw sourceError('WORKSPACE_UNCERTAIN', '上次运行命令尚未确认收尾；先人工核对进程及源码，不自动释放 writer');
    const retired = await this.gateway.run('retire', writer, {}, true);
    const change = this.state.pending.find((c) => c.id === writer.changeset_id);
    if (change) {
      const target = applySourceChanges(this.manifest, change.changes);
      const before = new Map(this.manifest.files.map((f) => [f.path, f.hash]));
      const after = new Map(target.files.map((f) => [f.path, f.hash]));
      const actual = new Map(retired.manifest.files.map((f) => [f.path, f.hash]));
      for (const p of new Set([...before.keys(), ...after.keys(), ...actual.keys()])) {
        if (![before.get(p) ?? null, after.get(p) ?? null].includes(actual.get(p) ?? null)) throw sourceError('WORKSPACE_CONFLICT', `${p} 与原基线/既定目标冲突`);
      }
      const recovered = await this.call('ita_workspace_reconcile', { p_old_token: writer.token, p_quiesced: true, p_hash: retired.manifest.code_hash, p_files: retired.manifest.files });
      await this.gateway.run('activate', recovered.writer);
      const result = await this.gateway.run('promote', recovered.writer, { baseline: this.manifest.files, files: target.files, target_hash: target.code_hash });
      await this.commit(recovered.writer, change, result.manifest);
    } else {
      const expected = new Map(this.manifest.files.map((f) => [f.path, f.hash]));
      if (retired.manifest.files.some((f) => expected.get(f.path) !== f.hash)) throw sourceError('WORKSPACE_CONFLICT', '恢复操作遗留未知源码，未覆盖');
      const recovered = await this.call('ita_workspace_reconcile', { p_old_token: writer.token, p_quiesced: true, p_hash: retired.manifest.code_hash, p_files: retired.manifest.files });
      if (recovered.writer) {
        await this.gateway.run('activate', recovered.writer);
        await this.gateway.run('materialize', recovered.writer, { files: this.manifest.files, target_hash: this.manifest.code_hash, expected_hash: retired.manifest.code_hash });
        await this.call('ita_workspace_finish_operation', { p_token: recovered.writer.token, p_hash: this.manifest.code_hash });
      }
    }
    await this.read();
  }
  /** Runtime recovery uses actual executor quiescence, never lease expiry alone. */
  async reconcileRuntime({ inspect, quiesce }) {
    await this.read();
    const writer=this.state.writer, baseline=this.manifest;
    if(!writer)return;
    if(writer.changeset_id||!['install','build','start','verify','preview','checkpoint'].includes(writer.kind))
      throw sourceError('WORKSPACE_UNCERTAIN','源码修改仍需按原记录核对；没有自动覆盖');
    const status=await inspect(writer);
    if(!status.terminal||status.leaseActive||status.active)
      throw sourceError('WORKSPACE_UNCERTAIN','执行仍活动或状态无法确认；未释放写入资格');
    const proof=await quiesce(writer);
    if(proof?.stopped!==true)throw sourceError('WORKSPACE_UNCERTAIN','运行进程未确认停止');
    await this.read();
    if(this.state.writer?.token!==writer.token||this.manifest.code_hash!==baseline.code_hash)
      throw sourceError('WORKSPACE_CONFLICT','核对期间工作区依据变化');
    const finalStatus=await inspect(writer);
    if(!finalStatus.terminal||finalStatus.leaseActive||finalStatus.active)
      throw sourceError('WORKSPACE_UNCERTAIN','核对期间执行重新变为活动；未释放写入资格');
    const retired=await this.gateway.run('retire',writer,{},true);
    if(retired.manifest.code_hash!==baseline.code_hash)
      throw sourceError('WORKSPACE_CONFLICT','实际源码与持久化版本不一致；保留差异，未覆盖');
    await this.call('ita_workspace_reconcile',{p_old_token:writer.token,p_quiesced:true,
      p_hash:retired.manifest.code_hash,p_files:retired.manifest.files});
    await this.read();
  }
  async prepare(changes, origin, target, requestId, observed = null) {
    return this.call('ita_workspace_prepare', { p_request_id: requestId, p_origin: origin, p_base_revision: this.state.revision, p_changes: changes, p_target_hash: target.code_hash, ...(observed ? { p_observed_files: observed.files } : {}) });
  }
  async commit(writer, change, manifest) {
    const result = await this.call('ita_workspace_commit', { p_token: writer.token, p_changeset_id: change.id, p_files: manifest.files.map(({ path, content }) => ({ path, content })), p_hash: manifest.code_hash });
    await this.read(); return result;
  }
  async apply(changes, { baseRevision = this.state?.revision, origin = 'agent', requestId = randomUUID(), beforeWrite = async () => {}, onWriteSuccess = async () => {}, invalidate = () => {} } = {}) {
    await this.read();
    if (baseRevision == null || baseRevision !== this.state.revision) throw sourceError('WORKSPACE_REVISION_CONFLICT', '请求基于旧 revision；未自动 rebase 或覆盖');
    const baseline = this.manifest;
    const target = applySourceChanges(baseline, changes);
    const recorded = sourceDiff(baseline, target);
    const change = await this.prepare(recorded, origin, target, requestId);
    const writer = await this.acquire('mutation', change.id);
    try {
      const {manifest:actual} = await this.gateway.run('activate_scan', writer);
      if (actual.code_hash !== baseline.code_hash) throw sourceError('WORKSPACE_CONFLICT', '写入前发现源码漂移；未覆盖');
      for (const [i, c] of changes.entries()) await beforeWrite(i, c.path);
      if (recorded.length) invalidate();
      const result = await this.gateway.run('promote', writer, { baseline: baseline.files, files: target.files, target_hash: target.code_hash });
      const committed = await this.commit(writer, change, result.manifest);
      const operations = [];
      for (const [i, c] of changes.entries()) {
        const changed = recorded.some((r) => r.path === c.path);
        await onWriteSuccess(i, c, changed);
        operations.push({ index: i, kind: c.operation === 'delete' ? 'delete_file' : 'write_file', path: c.path, status: 'succeeded', code_changed: changed });
      }
      return { status: 'succeeded', operations, ...committed };
    } catch (e) { await this.block(writer, e, e.code === 'WORKSPACE_CONFLICT' ? 'conflict' : e.code === 'WORKSPACE_PARTIAL' ? 'partial' : 'uncertain'); throw e; }
  }
  /** Executes the already persisted user ChangeSet, never prepares a second mutation. */
  async applyRequested(change) {
    await this.read();
    if (change.status === 'committed') return { revision: change.resulting_revision, reused: true };
    if (change.actor !== 'user' || change.task_id !== this.scope.p_task_id || change.status !== 'prepared'
      || change.base_revision !== this.state.revision || change.base_hash !== this.manifest.code_hash)
      throw sourceError('WORKSPACE_REVISION_CONFLICT', 'User Apply is stale; reload and reapply');
    const baseline = this.manifest, target = applySourceChanges(baseline, change.changes);
    if (target.code_hash !== change.target_hash) throw sourceError('WORKSPACE_CONFLICT', 'Persisted submission hash mismatch');
    const writer = await this.acquire('mutation', change.id);
    try {
      const {manifest:actual} = await this.gateway.run('activate_scan', writer);
      if (actual.code_hash !== baseline.code_hash) throw sourceError('WORKSPACE_CONFLICT', 'Physical source changed before Apply');
      const result = await this.gateway.run('promote', writer, { baseline: baseline.files, files: target.files, target_hash: target.code_hash });
      return await this.commit(writer, change, result.manifest);
    } catch (e) {
      await this.block(writer, e, e.code === 'WORKSPACE_CONFLICT' ? 'conflict' : e.code === 'WORKSPACE_PARTIAL' ? 'partial' : 'uncertain');
      throw e;
    }
  }
  async runtime(kind, run, { adoptLockfile = false, baseRevision = this.state?.revision } = {}) {
    const started=performance.now();
    await this.read();
    if (baseRevision == null || baseRevision !== this.state.revision) throw sourceError('WORKSPACE_REVISION_CONFLICT', '运行请求的源码依据已变更，未执行');
    const baseline = this.manifest, writer = await this.acquire(kind);
    try {
      const activated = await this.gateway.run('activate_scan', writer);
      if (activated.manifest.code_hash !== baseline.code_hash) throw sourceError('WORKSPACE_CONFLICT', '运行前源码已漂移');
      const commandStarted=performance.now();
      const result = await run();
      const commandFinished=performance.now();
      if (result?.timedOut) throw sourceError('WORKSPACE_UNCERTAIN', '命令超时，旧进程未确认停止');
      const actual = await this.gateway.scan(), diff = sourceDiff(baseline, actual);
      if (diff.length) {
        if (!adoptLockfile || diff.some((c) => c.path !== 'package-lock.json')) throw sourceError('WORKSPACE_CONFLICT', '运行操作修改了未声明源码，证据无效');
        const change = await this.prepare(diff, 'install_drift', actual, writer.operation_id, actual);
        await this.commit(writer, change, actual);
      } else await this.call('ita_workspace_finish_operation', { p_token: writer.token, p_hash: actual.code_hash });
      await this.read();
      const finished=performance.now();
      logger.info('workspace.runtime_timing',{projectId:this.scope.p_project_id,kind,revision:this.state.revision,
        preflight_ms:Math.round(commandStarted-started),command_ms:Math.round(commandFinished-commandStarted),
        confirmation_ms:Math.round(finished-commandFinished),total_ms:Math.round(finished-started)});
      return result;
    } catch (e) { await this.block(writer, e, e.code === 'WORKSPACE_CONFLICT' ? 'conflict' : e.code === 'WORKSPACE_PARTIAL' ? 'partial' : 'uncertain'); throw e; }
  }
  async evidence(kind, basis, status, result) {
    await this.read();
    const evidence = { workspace_revision: this.state.revision, code_hash: this.manifest.code_hash, basis_fingerprint: basis, status, result,
      task_id: this.scope.p_task_id, execution_id: this.scope.p_execution_id };
    if (!await this.call('ita_workspace_evidence', { p_kind: kind, p_evidence: evidence })) throw sourceError('WORKSPACE_EVIDENCE_STALE', '证据记录前源码已变更');
    await this.read(); return evidence;
  }
  valid(kind, basis) { return evidenceValid(this.state[kind], { revision: this.state.revision, codeHash: this.manifest.code_hash, basisFingerprint: basis }); }
  async assertCurrent(revision) {
    await this.read();
    if (this.state.revision !== revision || this.state.state !== 'confirmed' || this.state.writer) throw sourceError('WORKSPACE_REVISION_CONFLICT', '执行依据已变化，停止当前决策，保留源码');
  }
}
