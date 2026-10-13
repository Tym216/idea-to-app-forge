import { assertWorkerEnvironment } from './environment.js';
/**
 * Worker 启动前自检:npm run doctor
 * 只读检查,不领取任务、不创建沙箱;缺少配置时给出修复提示,不会崩溃。
 */
import { envFileLoaded, envFilePath } from './env.js';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from './config.js';
import { assertUnbudgetedOperatorInferenceAllowed } from './llm-cost-admission.js';
import { PROVIDERS, resolveProvider, buildConfiguredRequestBody, requestHeaders, providerProblems } from './llm-provider.js';

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
  console.log(envFileLoaded ? '   已加载 '+envFilePath : '   未找到配置文件(将只读取进程环境变量)');

  const provider = config.llmProvider;
  for (const problem of providerProblems(config)) {
    if (/^(PLAN_PROVIDER_OPTIONS|BUILD_PROVIDER_OPTIONS|LLM_TIMEOUT_MS|PLAN_TEMPERATURE|BUILD_TEMPERATURE|PLAN_REASONING_MODE|PLAN_REASONING_POLICY|LLM_REASONING_PROFILE)/.test(problem)) {
      bad(problem, '检查 app/worker/.env；provider options 必须是完整 JSON 对象，可写成 {} 或多行对象');
    }
  }
  const spec = PROVIDERS[provider];
  const llmKeyName = spec ? `${spec.prefix}_API_KEY` : null;
  if (!spec) bad('LLM_PROVIDER 无效', `可选 ${Object.keys(PROVIDERS).join(' / ')}`);
  if (spec) {
    try {
      const selected = resolveProvider(config);
      if (!selected.model) bad(`${spec.prefix}_MODEL 未配置`, '填写账号可用的明确模型 ID');
      else ok(`模型选择: ${provider} / ${selected.model}; JSON 模式: ${selected.jsonMode}`);
      if (spec.keyOptional) ok(`${llmKeyName}: ${selected.key ? mask(selected.key) : '未设置（本地接口可免 Key）'}`);
    } catch (error) { bad(error.message); }
  }

  const required = [
    ['SUPABASE_URL', 'Supabase → Project Settings → API → Project URL', false],
    ['SUPABASE_SERVICE_ROLE_KEY', 'Supabase → Project Settings → API → service_role / secret key(只放 Worker)', true],
    ...(spec && !spec.keyOptional ? [[llmKeyName, `${spec.help} → API keys`, true]] : []),
    ['DAYTONA_API_KEY', 'https://app.daytona.io → Keys → Create Key', true],
    ['DAYTONA_API_URL', '通常填 https://app.daytona.io/api', false],
  ];

  for (const [name, hint, secret] of required) {
    const fromGenericKey = name === llmKeyName && !env(name) && env('LLM_API_KEY');
    const label = fromGenericKey ? 'LLM_API_KEY' : name;
    const value = fromGenericKey || env(name);
    if (value) ok(`${label} = ${secret ? mask(value) : value}`);
    else bad(`${name} 未配置`, `在 app/worker/.env 填写;获取位置:${hint}`);
  }

  for (const name of ['MAX_TOOL_STEPS', 'MAX_FIX_ROUNDS']) {
    const value = env(name);
    if (!value) ok(`${name} 未设置,使用默认值 ${name === 'MAX_TOOL_STEPS' ? config.maxToolSteps : config.maxFixRounds}`);
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

  assertWorkerEnvironment();
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

  try {
    const { checkWorkspaceSchema } = await import('./supabase.js');
    await checkWorkspaceSchema(admin);
    ok('Workspace/Demo 0006–0009 字段与只读 RPC 自检通过（未领取任务）');
  } catch (error) {
    bad(String(error.message), '停止旧 Worker，依序执行 0001–0009；不要重跑旧迁移，核对 service_role 授权与 schema cache');
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
  if (providerProblems(config).length) return skip('LLM 配置无效,跳过真实模型请求');
  if (!llmKeyName) return skip('供应商配置无效,跳过');
  let selected;
  try { selected = resolveProvider(config); }
  catch { return skip('模型配置无效,跳过'); }
  const { model, url } = selected;
  if (selected.requiresKey && !selected.key) return skip(`缺少 ${llmKeyName},跳过`);
  if (!model) return skip('缺少模型名,跳过');

  try {
    const started = performance.now();
    assertUnbudgetedOperatorInferenceAllowed(config);
    const res = await timedFetch(url, {
      method: 'POST',
      headers: requestHeaders(selected.key),
      body: JSON.stringify(buildConfiguredRequestBody(config, 'doctor_probe', { providerName: provider, model, messages: [{ role: 'user', content: '请简短回复 ok。' }], temperature: 0, json: false, upstream: config.openrouterUpstream })),
    });
    const text = await res.text();
    if (!res.ok) {
      bad(`${model} 返回 HTTP ${res.status}:${text.slice(0, 200)}`, res.status === 401 ? 'API Key 无效' : '检查模型名、余额或网络');
      return;
    }
    const payload = JSON.parse(text);
    const reply = payload?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) { bad(`${model} 未返回可用文本`, '检查模型是否支持文本 Chat Completions'); return; }
    ok(`${model} 可用,${Math.round(performance.now() - started)}ms,返回模型:${payload.model || '(未提供)'},回复:${JSON.stringify(reply.slice(0, 20))}`);
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
  assertWorkerEnvironment(); // shared runtime guard before any API/SDK work
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
