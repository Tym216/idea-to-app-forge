/** Explicit operator-attested legacy recovery. Never infer quiescence from an expired lease. */
import './env.js';
import { SandboxWorkspace } from './workspace.js';
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes('--project') || !args.includes('--sandbox') || !args.includes('--confirm-quiesced')) {
  console.error('先停止全部旧 Worker，并确认原沙箱上传/命令/后台写入已结束。随后运行：admin:workspace-legacy -- --project <uuid> --sandbox <原 sandbox_id> --confirm-quiesced。此命令核对并持久化实际源码，不重放旧写入；不能确认收尾时不要运行。');
  process.exit(2);
}
const { admin } = await import('./supabase.js');
const { getSandboxProvider } = await import('./sandbox/index.js');
const projectId = value('--project'), sandboxId = value('--sandbox');
const { data: p, error } = await admin.from('ita_projects').select('id,workspace_writer').eq('id', projectId).single();
if (error) throw new Error(`读取 legacy authority 失败：${error.message}`);
if (p.workspace_writer?.kind !== 'legacy') throw new Error('项目没有 retained legacy writer；未修改');
const gateway = new SandboxWorkspace(getSandboxProvider('daytona'), sandboxId);
const actual = await gateway.scan();
const result = await admin.rpc('ita_workspace_reconcile_legacy', {
  p_project_id: projectId, p_old_token: p.workspace_writer.token, p_sandbox_id: sandboxId,
  p_quiesced: true, p_files: actual.files, p_hash: actual.code_hash,
});
if (result.error) throw new Error(`legacy 核对失败，authority 保持 blocked：${result.error.message}`);
console.log(JSON.stringify(result.data));
