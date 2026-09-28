import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

/** 只更新指定 Auth 用户，不删除/重建用户，不改变项目归属，也不自动重试写请求。 */
export async function updateDemoAccount(client, { id, currentEmail, email, password }) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) throw new Error('用户 ID 格式不正确');
  if (!email || !email.includes('@') || /\s/.test(email)) throw new Error('新邮箱格式不正确');
  if (typeof password !== 'string' || password.length < 8) throw new Error('密码至少 8 位');
  const { data, error } = await client.auth.admin.getUserById(id);
  if (error || !data?.user) throw new Error('无法读取指定用户，请核对 ID 和 Supabase 配置');
  if (!data.user.email || data.user.email.toLowerCase() !== currentEmail.toLowerCase()) throw new Error('原邮箱不匹配，未修改账号');
  const updated = await client.auth.admin.updateUserById(id, { email, password, email_confirm: true });
  if (updated.error) throw new Error(`更新失败：${updated.error.message}`);
  if (updated.data?.user?.id !== id) throw new Error('更新结果无法确认，请去 Supabase Users 核对，勿自动重试');
  return id;
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在交互终端运行；不接受通过命令参数或文件传入密码');
  const { config } = await import('./config.js');
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) throw new Error('请先配置 Worker 的 Supabase URL 和 service role key');
  const { admin } = await import('./supabase.js');
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, next) { if (!muted) process.stdout.write(chunk); next(); } });
  output.isTTY = true;
  output.columns = process.stdout.columns;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const secret = async (label) => {
    process.stdout.write(label);
    muted = true;
    try { return await rl.question(''); }
    finally { rl.history = []; muted = false; process.stdout.write('\n'); }
  };
  try {
    console.log('修改现有示例账号。保留用户 ID、项目和代码；新邮箱应由你控制。');
    const id = (await rl.question('Supabase Authentication → Users 中原账号的 User UID：')).trim();
    const currentEmail = (await rl.question('输入原账号邮箱（用于核对）：')).trim();
    const email = (await rl.question('新示例邮箱：')).trim();
    const password = await secret('新密码（不显示）：');
    if (password !== await secret('再次输入新密码（不显示）：')) throw new Error('两次密码不一致，未修改');
    if (await rl.question('输入 update 确认修改该账号：') !== 'update') { console.log('已取消，未修改'); return; }
    await updateDemoAccount(admin, { id, currentEmail, email, password });
    console.log('更新成功，用户 ID 保持不变。请退出平台后用新邮箱和密码重新登录。');
  } finally { rl.close(); output.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (e) => {
    const { redact } = await import('./telemetry.js');
    console.error(redact(e.message, 300));
    process.exitCode = 1;
  });
}
