/**
 * Worker 启动前自检:npm run doctor
 * 只读检查,不领取任务、不创建沙箱;缺少配置时给出修复提示,不会崩溃。
 */
import { envFileLoaded } from './env.js';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const env = (name) => (process.env[name] || '').trim();
const mask = (value) => (!value ? '(空)' : value.length <= 8 ? '****' : `${value.slice(0, 4)}****${value.slice(-4)}`);

let failures = 0;
const ok = (msg) => console.log(`✅ ${msg}`);
const bad = (msg, hint) => {
  failures += 1;
  console.log(`❌ ${msg}${hint ? `\n   → ${hint}` : ''}`);
};
const skip = (msg) => console.log(`⏭️  ${msg}`);

async function timedFetch(url, options = {}, ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function checkEnv() {
  console.log('\n[1/4] 环境变量');
  console.log(envFileLoaded ? '   已加载 app/worker/.env' : '   未找到 app/worker/.env(将只读取进程环境变量)');

  const provider = env('LLM_PROVIDER') || 'deepseek';
  const llmKeyName = provider === 'zhipu' ? 'ZHIPU_API_KEY' : 'DEEPSEEK_API_KEY';
  if (!['deepseek', 'zhipu'].includes(provider)) {
    bad(`LLM_PROVIDER=${provider} 无效`, '只能填 deepseek 或 zhipu');
  }

  const required = [
    ['SUPABASE_URL', 'Supabase → Project Settings → API → Project URL', false],
    ['SUPABASE_SERVICE_ROLE_KEY', 'Supabase → Project Settings → API → service_role / secret key(只放 Worker)', true],
    [llmKeyName, provider === 'zhipu' ? 'https://open.bigmodel.cn → API 密钥' : 'https://platform.deepseek.com → API keys', true],
    ['DAYTONA_API_KEY', 'https://app.daytona.io → Keys → Create Key', true],
    ['DAYTONA_API_URL', '通常填 https://app.daytona.io/api', false],
  ];

  for (const [name, hint, secret] of required) {
    const value = env(name);
    if (value) ok(`${name} = ${secret ? mask(value) : value}`);
    else bad(`${name} 未配置`, `在 app/worker/.env 填写;获取位置:${hint}`);
  }

  for (const name of ['MAX_TOOL_STEPS', 'MAX_FIX_ROUNDS']) {
    const value = env(name);
    if (!value) ok(`${name} 未设置,使用默认值 ${name === 'MAX_TOOL_STEPS' ? 40 : 6}`);
    else if (!/^\d+$/.test(value) || Number(value) < 1) bad(`${name}=${value} 不是正整数`);
    else ok(`${name} = ${value}`);
  }
  return { provider, llmKeyName };
}

async function checkSupabase() {
  console.log('\n[2/4] Supabase(service_role)');
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return skip('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY,跳过');

  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } });
  const tables = ['ita_projects', 'ita_messages', 'ita_tasks', 'ita_files', 'ita_snapshots', 'ita_memories'];
  for (const table of tables) {
    try {
      const { error } = await admin.from(table).select('*', { head: true, count: 'exact' }).limit(1);
      if (error) bad(`表 ${table} 不可访问:${error.message}`, '确认已在 SQL Editor 执行 0001_init.sql,且填写的是 service_role key');
      else ok(`表 ${table} 可访问`);
    } catch (error) {
      bad(`连接 Supabase 失败:${String(error.message || error)}`, '检查 SUPABASE_URL 是否正确、网络是否可达');
      return;
    }
  }

  // 用随机 task_id 调用心跳:不会命中任何任务,只验证 service_role 的 EXECUTE 权限
  const { error } = await admin.rpc('ita_heartbeat_task', {
    p_task_id: '00000000-0000-0000-0000-000000000000',
    p_worker_id: 'doctor',
    p_execution_id: '00000000-0000-0000-0000-000000000000',
    p_lease_seconds: 1,
  });
  if (error) bad(`RPC ita_heartbeat_task 不可调用:${error.message}`, '重新执行 0001_init.sql 中的 GRANT EXECUTE 部分');
  else ok('RPC ita_heartbeat_task 可调用(ita_claim_task 同一授权块,未实际调用以免领取任务)');
}

async function checkLlm({ provider, llmKeyName }) {
  console.log(`\n[3/4] 大模型(${provider})`);
  const key = env(llmKeyName);
  if (!key) return skip(`缺少 ${llmKeyName},跳过`);

  const baseUrl = provider === 'zhipu'
    ? env('ZHIPU_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4'
    : env('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com/v1';
  const model = provider === 'zhipu' ? env('ZHIPU_MODEL') || 'glm-4-plus' : env('DEEPSEEK_MODEL') || 'deepseek-chat';

  try {
    const started = Date.now();
    const res = await timedFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复 ok' }], max_tokens: 5, temperature: 0 }),
    });
    const text = await res.text();
    if (!res.ok) {
      bad(`${model} 返回 HTTP ${res.status}:${text.slice(0, 200)}`, res.status === 401 ? 'API Key 无效' : '检查模型名、余额或网络');
      return;
    }
    const reply = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
    ok(`${model} 可用,${Date.now() - started}ms,回复:${JSON.stringify(reply.slice(0, 20))}`);
  } catch (error) {
    bad(`请求模型失败:${String(error.message || error)}`, '检查网络或 BASE_URL');
  }
}

async function checkDaytona() {
  console.log('\n[4/4] Daytona(只读鉴权,不创建沙箱)');
  const key = env('DAYTONA_API_KEY');
  const apiUrl = (env('DAYTONA_API_URL') || 'https://app.daytona.io/api').replace(/\/$/, '');
  if (!key) return skip('缺少 DAYTONA_API_KEY,跳过');

  try {
    const res = await timedFetch(`${apiUrl}/sandbox`, {
      headers: { Authorization: `Bearer ${key}`, 'X-Daytona-Organization-Target': env('DAYTONA_TARGET') || 'us' },
    });
    const text = await res.text();
    if (!res.ok) {
      bad(`Daytona 返回 HTTP ${res.status}:${text.slice(0, 200)}`, res.status === 401 ? 'DAYTONA_API_KEY 无效' : '检查 DAYTONA_API_URL');
      return;
    }
    let count = '?';
    try {
      const data = JSON.parse(text);
      count = Array.isArray(data) ? data.length : Array.isArray(data?.items) ? data.items.length : '?';
    } catch { /* 非 JSON 时只报告可用 */ }
    ok(`Daytona 鉴权通过,当前沙箱数:${count}`);
  } catch (error) {
    bad(`请求 Daytona 失败:${String(error.message || error)}`, '检查网络或 DAYTONA_API_URL');
  }
}

async function main() {
  console.log('Forge Worker 自检');
  const llm = checkEnv();
  await checkSupabase();
  await checkLlm(llm);
  await checkDaytona();
  if (process.argv.includes('--smoke')) {
    console.log('\n[可选] Daytona 冒烟测试(会创建并删除一个测试沙箱)');
    const { runSmoke } = await import('./smoke-daytona.js');
    if ((await runSmoke()) !== 0) failures += 1;
  }
  console.log(failures === 0
    ? '\n全部通过,可以执行 npm start'
    : `\n共 ${failures} 项未通过,请按提示修复后重新执行 npm run doctor`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(`❌ 自检脚本异常:${String(error?.message || error)}`);
  process.exitCode = 1;
});
