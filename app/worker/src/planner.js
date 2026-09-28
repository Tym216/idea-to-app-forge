import { parseJson } from './llm.js';
import { PLAN_CHECKS_SPEC, validateChecks } from './verify.js';

/**
 * 计划(Plan)与执行阶段(Stages)。
 * - Plan 模式:输出需求理解/功能范围/实现步骤/设计方向/必要问题(≤3),保存为待审阅版本,不改代码。
 * - Build 模式:读取已批准的计划与反馈;直接 Build 时先生成简短行动计划(视为已授权)。
 * - 执行阶段只在拿到真实工具结果后才标记 done/failed,不伪造进度。
 */
export const MAX_QUESTIONS = 3;

export const MAX_ACCEPTANCE = 12;

const ACCEPTANCE_RULES = `验收条件 acceptance 规则:
- 每条是用户可观察的行为:{"id":"A1","action":"在页面上执行什么操作","expect":"预期看到/发生什么","external":false,"steps":[{"op":"expectText","selector":"main","contains":"预期内容"}]}。
- 每项核心需求至少对应一条;必须描述行为结果(例如“添加后列表多出该项”“按方向键后玩家移动一格”),不能只写“页面存在”“按钮可点击”。
- 只覆盖用户要求的功能,不得添加用户未要求的功能;简单修复只写与本次改动相关的 1-3 条。
- 依赖真实后端/第三方服务(支付、邮件、外部 API 等)的条目设 "external":true。
- 条目必须能在浏览器中验证,id 依次为 A1、A2…
- 验收一旦批准，Build 只能执行其中的 steps；不能重新编写或放宽检查。`;

export const PLAN_PROMPT = `你是资深产品工程师。根据用户需求输出实现计划,只输出一个 JSON 对象:
{"understanding":"一段话复述需求","scope":["功能点"],"flows":["核心用户流程,一步一句"],"rules":["关键交互规则"],
 "storage":"数据保存方式一句话(例如 仅内存 / localStorage / 用户要求的后端)","steps":["实现步骤"],"design":"设计方向一句话",
 "acceptance":[{"id":"A1","action":"操作","expect":"预期结果","external":false,"steps":[{"op":"expectText","selector":"main","contains":"预期内容"}]}],
 "questions":[{"id":"q1","question":"问题","options":["选项A","选项B"],"recommended":"选项A"}]}
规则:
- 只有缺少会影响实现的关键信息时才提问,最多 ${MAX_QUESTIONS} 个;信息充分时 questions 为 []。
- 每个问题给 2-4 个选项,recommended 必须是其中之一。
- 不要为装饰添加与需求无关的功能;简单修复时 flows/rules/steps 只写相关部分,保持简短。
${ACCEPTANCE_RULES}
${PLAN_CHECKS_SPEC}`;

export const ACTION_PROMPT = `你将直接执行构建。用 JSON 输出简短行动计划,只输出 JSON:
{"understanding":"一句话","steps":["1-6 个简短步骤"],"acceptance":[{"id":"A1","action":"操作","expect":"预期结果","external":false,"steps":[{"op":"expectText","selector":"main","contains":"预期内容"}]}]}
${ACCEPTANCE_RULES}
${PLAN_CHECKS_SPEC}`;

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/** 验收条件校验:1-12 条、id 唯一、action/expect 非空;返回规范化副本(由平台保存,Agent 不能修改)。 */
export function validateAcceptance(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('acceptance 必须是非空数组');
  if (list.length > MAX_ACCEPTANCE) throw new Error(`acceptance 最多 ${MAX_ACCEPTANCE} 条`);
  const seen = new Set();
  const acceptance = list.map((a, i) => {
    const id = String(a?.id ?? '').trim();
    if (!/^A\d{1,2}$/.test(id) || seen.has(id)) throw new Error(`acceptance[${i}].id 必须形如 A1 且唯一`);
    seen.add(id);
    if (!nonEmpty(a?.action) || !nonEmpty(a?.expect)) throw new Error(`acceptance[${i}] 缺少 action/expect`);
    return { id, action: a.action.trim().slice(0, 300), expect: a.expect.trim().slice(0, 300), external: a.external === true, steps: a.steps };
  });
  const checks = acceptance.filter((a) => a.steps != null).map(({ id, steps }) => ({ id, steps }));
  validateChecks(acceptance, checks);
  return acceptance;
}

export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('计划校验失败: 必须是 JSON 对象');
  if (!nonEmpty(plan.understanding)) errors.push('understanding 不能为空');
  for (const key of ['scope', 'steps']) {
    if (!Array.isArray(plan[key]) || !plan[key].length || !plan[key].every(nonEmpty)) errors.push(`${key} 必须是非空字符串数组`);
  }
  if (!nonEmpty(plan.design)) errors.push('design 不能为空');
  for (const key of ['flows', 'rules']) {
    if (plan[key] != null && (!Array.isArray(plan[key]) || !plan[key].every(nonEmpty))) errors.push(`${key} 必须是字符串数组`);
  }
  if (plan.storage != null && typeof plan.storage !== 'string') errors.push('storage 必须是字符串');
  let acceptance;
  try { acceptance = validateAcceptance(plan.acceptance); } catch (e) { errors.push(e.message); }
  const qs = plan.questions ?? [];
  if (!Array.isArray(qs)) errors.push('questions 必须是数组');
  else {
    if (qs.length > MAX_QUESTIONS) errors.push(`questions 最多 ${MAX_QUESTIONS} 个`);
    qs.forEach((q, i) => {
      if (!nonEmpty(q?.id) || !nonEmpty(q?.question)) errors.push(`questions[${i}] 缺少 id/question`);
      if (!Array.isArray(q?.options) || q.options.length < 2 || !q.options.every(nonEmpty)) errors.push(`questions[${i}].options 至少 2 个`);
      else if (q.recommended != null && !q.options.includes(q.recommended)) errors.push(`questions[${i}].recommended 必须是选项之一`);
    });
  }
  if (errors.length) throw new Error(`计划校验失败: ${errors.join('; ')}`);
  return { ...plan, acceptance, questions: qs };
}

export function validateAction(plan) {
  if (!plan || !nonEmpty(plan.understanding) || !Array.isArray(plan.steps) || !plan.steps.length || !plan.steps.every(nonEmpty)) {
    throw new Error('行动计划校验失败: 需要 understanding 与非空 steps');
  }
  return { understanding: plan.understanding, steps: plan.steps.slice(0, 6), acceptance: validateAcceptance(plan.acceptance) };
}

/** 调用模型并校验;失败把错误反馈给模型重试一次,仍失败抛错(不使用默认值)。 */
export async function generateStructured({ chat, system, context, validate, taskId, code }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: context },
  ];
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await chat(messages, { json: true, temperature: 0.3, taskId });
    try {
      return validate(parseJson(raw));
    } catch (error) {
      lastError = error;
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: `输出无效(${error.message}),请修正后只输出一个 JSON 对象。` });
    }
  }
  const error = new Error(`${code}: ${lastError?.message || lastError}`);
  error.code = code;
  throw error;
}

export function renderFeedback(feedback) {
  if (!feedback.length) return '(无)';
  return feedback
    .map((f) => {
      const answers = Object.entries(f.answers || {}).map(([k, v]) => `${k}=${v}`).join('; ');
      return `- [v${f.plan_version}] ${f.content || ''}${answers ? ` (回答: ${answers})` : ''}`;
    })
    .join('\n');
}

/** Build 读取的计划上下文:已批准版本 + 全部反馈,要求严格按此执行。 */
export function renderApprovedPlan(plan, feedback) {
  const c = plan.content || {};
  return [
    `【已批准的计划 v${plan.version}(必须按此实现,不要另起方案)】`,
    `需求理解: ${c.understanding}`,
    c.scope ? `功能范围:\n${c.scope.map((s) => `- ${s}`).join('\n')}` : '',
    c.flows?.length ? `核心用户流程:\n${c.flows.map((s) => `- ${s}`).join('\n')}` : '',
    c.rules?.length ? `关键规则:\n${c.rules.map((s) => `- ${s}`).join('\n')}` : '',
    c.storage ? `数据保存: ${c.storage}` : '',
    `实现步骤:\n${(c.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    c.acceptance?.length ? renderAcceptance(c.acceptance) : '',
    c.acceptance?.length ? `固定浏览器检查(按计划实现所需选择器，不得修改): ${JSON.stringify(c.acceptance.filter((a) => a.steps?.length).map(({ id, steps }) => ({ id, steps })))}` : '',
    c.design ? `设计方向: ${c.design}` : '',
    `用户反馈:\n${renderFeedback(feedback)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderAcceptance(list) {
  return `验收条件(由平台保存,必须全部通过浏览器验收;不能删减、放宽或跳过):\n${list
    .map((a) => `- ${a.id}${a.external ? '[外部服务]' : ''}: ${a.action} → ${a.expect}`)
    .join('\n')}`;
}

// ------------------------------------------------------------------ 执行阶段
export const STAGES = [
  { key: 'understand', label: '理解需求' },
  { key: 'read', label: '读取现有代码' },
  { key: 'edit', label: '修改代码' },
  { key: 'build', label: '安装依赖并构建' },
  { key: 'start', label: '启动应用' },
  { key: 'preview', label: '预览就绪' },
  { key: 'verify', label: '浏览器验收' },
];

export function initialStages() {
  return STAGES.map((s) => ({ ...s, status: 'pending', note: '' }));
}

/** 仅根据真实工具结果推进阶段状态。 */
export function applyToolResult(stages, tool, ok, note = '') {
  const set = (key, status, n = '') => {
    const s = stages.find((x) => x.key === key);
    if (s) {
      s.status = status;
      s.note = n;
    }
  };
  const done = (key) => stages.find((x) => x.key === key)?.status === 'done';
  if (!done('understand')) set('understand', 'done');
  switch (tool) {
    case 'list_files':
    case 'read_file':
      if (ok && !done('read')) set('read', 'done');
      break;
    case 'write_file':
    case 'delete_file':
      if (!done('read')) set('read', 'done', '沿用上下文中的代码');
      set('edit', ok ? 'done' : 'failed', ok ? '' : note);
      // 改代码后之前的构建/启动结果失效
      for (const key of ['build', 'start', 'preview', 'verify']) if (done(key)) set(key, 'pending', '代码已修改,需重新验证');
      break;
    case 'build':
      set('build', ok ? 'done' : 'failed', ok ? '' : '构建失败,正在修复');
      if (ok && !done('edit')) set('edit', 'done', '未改动代码');
      break;
    case 'start_dev':
      set('start', ok ? 'done' : 'failed', ok ? '' : note);
      if (ok) set('preview', 'done');
      break;
    case 'verify':
      set('verify', ok ? 'done' : 'failed', ok ? '' : note);
      break;
    default:
      break;
  }
  return stages;
}

export function markRunning(stages, tool) {
  const key = { list_files: 'read', read_file: 'read', write_file: 'edit', delete_file: 'edit', build: 'build', start_dev: 'start', verify: 'verify' }[tool];
  const s = stages.find((x) => x.key === key);
  if (s && s.status !== 'done') {
    s.status = 'running';
    s.note = '';
  }
  return stages;
}
