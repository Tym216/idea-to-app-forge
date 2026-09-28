/**
 * 管理员孤儿沙箱核对 / 清理(仅 Worker 端,使用 service_role 与 Daytona Key)。
 *   npm run admin:sandboxes                         # dry-run:只列出,不删除
 *   npm run admin:sandboxes -- --delete <id> [<id>…] --confirm
 * 删除时逐个复核:必须带 forge_project_id 标签,且该项目在数据库中不存在,也没有任何项目引用该沙箱。
 */
import './env.js';
import { config, assertRunnable } from './config.js';
import { classifySandboxes } from './deletion.js';

const args = process.argv.slice(2);
const deleteIdx = args.indexOf('--delete');
const targets = deleteIdx >= 0 ? args.slice(deleteIdx + 1).filter((a) => !a.startsWith('--')) : [];
const confirm = args.includes('--confirm');

if (assertRunnable().length) {
  console.error('缺少 Worker 配置(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DAYTONA_API_KEY 等),请先填写 app/worker/.env');
  process.exit(1);
}
const { admin } = await import('./supabase.js');
const { getSandboxProvider } = await import('./sandbox/index.js');
const provider = getSandboxProvider('daytona');

const { data: projects, error } = await admin.from('ita_projects').select('id, sandbox_id');
if (error) throw new Error(`读取项目失败:${error.message}`);
const referenced = new Set(projects.map((p) => p.sandbox_id).filter(Boolean));
const sandboxes = (await provider.list()).map((sb) => ({ ...sb, referenced: referenced.has(sb.id) }));
const report = classifySandboxes(sandboxes.filter((sb) => !sb.referenced), projects.map((p) => p.id));

console.log(`Daytona 中 app=forge 的沙箱:${sandboxes.length} 个;数据库仍引用:${referenced.size} 个`);
console.log(`\n[孤儿] 带项目标签但项目已不存在(可按 ID 显式删除):`);
for (const sb of report.orphan) console.log(`  ${sb.id}  project=${sb.labels.forge_project_id}  state=${sb.state}`);
console.log(`\n[归属未知] 无项目标签(旧版本创建),不会被删除,请人工核对:`);
for (const sb of report.unknown) console.log(`  ${sb.id}  state=${sb.state}`);

if (!targets.length) {
  console.log('\n(dry-run:未删除任何沙箱。删除需 --delete <id> … --confirm)');
  process.exit(0);
}
if (!confirm) {
  console.error('\n拒绝执行:删除必须同时提供 --confirm');
  process.exit(2);
}
const orphanIds = new Set(report.orphan.map((sb) => sb.id));
for (const id of targets) {
  if (!orphanIds.has(id)) {
    console.log(`跳过 ${id}:不是已确认的孤儿沙箱(无标签、项目仍存在或仍被引用)`);
    continue;
  }
  const r = await provider.destroy(id);
  console.log(`已删除 ${id}${r.existed ? '' : '(已不存在)'}`);
}
void config;
