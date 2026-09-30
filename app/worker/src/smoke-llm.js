/** Explicit, potentially billable, single model request. Not included in npm test. */
import { config } from './config.js';
import { providerProblems, resolveProvider } from './llm-provider.js';
import { chat } from './llm.js';
import { parseJson } from './llm.js';

export async function runSmoke(chatImpl = chat) {
  const problems = providerProblems(config);
  if (problems.length) throw new Error(`LLM 配置无效: ${problems.join('; ')}`);
  const selected = resolveProvider(config);
  console.log(`LLM 冒烟测试: ${selected.name}/${selected.model}（发送一次真实请求，可能计费）`);
  const raw = await chatImpl([
    { role: 'system', content: '只输出一个 JSON 对象，格式为 {"tool":"finish","args":{"summary":"ok"}}。' },
    { role: 'user', content: '返回上述 JSON。' },
  ], { purpose: 'build_decision', interactionMode: 'json_action', json: true, temperature: 0.1 });
  const action = parseJson(raw);
  if (action?.tool !== 'finish' || action?.args?.summary !== 'ok') throw new Error('模型已返回文本，但 JSON action 与预期不符');
  console.log('✅ 请求映射、响应归一化和 JSON action 解析通过');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runSmoke().catch((error) => { console.error(`❌ LLM 冒烟测试失败: ${error.code || 'ERROR'} ${error.message}`); process.exitCode = 1; });
}
