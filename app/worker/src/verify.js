/**
 * 通用浏览器验收(平台公共逻辑,不含任何具体应用的选择器或业务规则)。
 *
 * 流程:Worker 在沙箱内安装 playwright-core + chromium(每个沙箱一次)→ 写入平台自带的 runner 与
 * Planner 随计划版本保存的检查脚本(声明式 JSON,可重复执行)→ 对沙箱内实际运行的 http://127.0.0.1:5173 执行:
 *   1. 基础检查:页面可打开、核心内容可见(非空白/Loading 占位)、收集页面异常与本应用请求失败;
 *   2. 功能检查:按验收条件逐条执行点击/输入/按键并断言行为结果。
 * 只把简短结构化结果返回给 Agent;截图仅作为证据保存在沙箱,不发送给模型。
 */
export const PLAYWRIGHT_VERSION = '1.52.0';
export const VERIFY_URL = 'http://127.0.0.1:5173';
const MARKER = '__FORGE_VERIFY__';

const ACTION_OPS = ['click', 'fill', 'press', 'wait', 'reload', 'save'];
const ASSERT_OPS = ['expectVisible', 'expectHidden', 'expectText', 'expectCount', 'expectTrue', 'expectChanged'];
export const VERIFY_OPS = [...ACTION_OPS, ...ASSERT_OPS];

export const PLAN_CHECKS_SPEC = `每条非外部验收条件还必须包含 steps，作为随计划版本保存的浏览器检查：
{"id":"A1","action":"添加任务","expect":"列表出现输入的任务","external":false,"steps":[
  {"op":"fill","selector":"[data-testid=task-input]","value":"买牛奶"},
  {"op":"click","selector":"[data-testid=add-task]"},
  {"op":"expectText","selector":"[data-testid=task-list]","contains":"买牛奶"}]}
- 操作：click{selector} fill{selector,value} press{key,selector?} wait{ms≤3000} reload save{name,js}。
- 断言：expectVisible{selector} expectHidden{selector} expectText{selector?,contains} expectCount{selector,equals|min|max} expectTrue{js} expectChanged{name,js}。
- 每条非外部条件至少一个验证操作结果的断言；不要用 body/html/#root 可见代替实际功能。需要验证变化时先 save 再 expectChanged。
- 优先用页面现有可访问名称或稳定选择器；新应用可约定 data-testid，Build 必须按计划实现。每条检查从独立新页面开始。
- 外部服务若无法在浏览器实际验证，可设 external:true 且省略 steps；这会显示“未验证”，不能标记整体成功。
- 已批准计划的文字和 steps 一起固定；修改它们必须产生新计划版本供用户审阅。`;

export const VERIFY_SPEC = `verify 工具：构建成功、start_dev 后用已批准计划内固定的检查验收应用。
{"thought":"...","tool":"verify","args":{}}
检查由 Worker 从计划读取；不得提交 checks、替代断言或选择器。验收结果有警告或证据不足时停止自动修复，保留当前版本并如实说明；明确 blocker 时也停止，等待用户决定。
若计划本身有误或与实际架构冲突，调用 request_plan_revision 说明原因，停止本轮 Build，等待用户重新审阅计划。`;

// ------------------------------------------------------------------ 沙箱内 runner(平台代码)
export const RUNNER_SOURCE = String.raw`import { readFileSync, mkdirSync } from 'node:fs';
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const MARK = '${MARKER}';
const out = (o) => { process.stdout.write('\n' + MARK + JSON.stringify(o) + '\n'); process.exit(0); };
const short = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
let pw;
try { pw = await import('playwright-core'); } catch { try { pw = await import('playwright'); } catch (e) { out({ toolError: '未安装 playwright: ' + short(e.message) }); } }
const chromium = pw.chromium || pw.default?.chromium;
let browser;
try { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); }
catch (e) { out({ toolError: '浏览器启动失败: ' + short(e.message, 300) }); }
const T = Math.min(spec.timeoutMs || 5000, 10000);
const origin = new URL(spec.url).origin;
const dir = spec.outDir || '.';
mkdirSync(dir, { recursive: true });
// API requests may be optional; a failed core action is judged by its own check.
const CORE = ['document', 'script', 'stylesheet'];
const safeUrl = (raw) => { try { const u = new URL(raw); return u.origin === origin ? u.pathname : u.origin + u.pathname; } catch { return '[invalid URL]'; } };
const sameOrigin = (raw) => { try { return new URL(raw).origin === origin; } catch { return false; } };

function watch(page, sink) {
  page.on('pageerror', (e) => sink.blocking.push('页面异常: ' + short(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') sink.warnings.push('console: ' + short(m.text())); });
  page.on('requestfailed', (r) => {
    const u = r.url(); const rt = r.resourceType();
    const msg = '请求失败 ' + rt + ' ' + short(safeUrl(u), 80) + ' ' + (r.failure()?.errorText || '');
    if (sameOrigin(u) && CORE.includes(rt)) sink.blocking.push(msg); else sink.warnings.push(msg + '(非阻断)');
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const u = r.url(); const rt = r.request().resourceType();
    const msg = 'HTTP ' + r.status() + ' ' + rt + ' ' + short(safeUrl(u), 80);
    if (sameOrigin(u) && CORE.includes(rt) && !/favicon/.test(u)) sink.blocking.push(msg); else sink.warnings.push(msg + '(非阻断)');
  });
}
async function open(sink) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  watch(page, sink);
  try { await page.goto(spec.url, { waitUntil: 'load', timeout: 20000 }); }
  catch (e) { sink.blocking.push('无法打开页面: ' + short(e.message)); }
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  return { context, page };
}
async function until(page, fn) {
  const end = Date.now() + T; let last = { ok: false, detail: '超时' };
  while (Date.now() < end) {
    try { last = await fn(); } catch (e) { last = { ok: false, detail: short(e.message) }; }
    if (last.ok) return last;
    await page.waitForTimeout(150);
  }
  return last;
}
const evalJs = (page, js) => page.evaluate('(() => (' + js + '))()');
// Snapshot only selectors named by the approved check. Never return DOM or arbitrary attributes.
async function snapshot(page, steps) {
  const selectors = new Set();
  for (const s of steps) {
    if (s.selector) selectors.add(s.selector);
    for (const m of String(s.js || '').matchAll(/document\.querySelector\(\s*(['"])(.*?)\1\s*\)/g)) selectors.add(m[2]);
  }
  return page.evaluate((list) => ({
    bodyText: (document.body?.innerText || '').trim().slice(0, 100),
    elements: list.map((selector) => {
      try {
        const el = document.querySelector(selector);
        return { selector, exists: !!el, ...(el ? {
          visible: !!(el.getClientRects().length), text: (el.textContent || '').trim().slice(0, 80),
          row: el.dataset?.row ?? null, col: el.dataset?.col ?? null,
          disabled: 'disabled' in el ? !!el.disabled : null,
        } : {}) };
      } catch { return { selector, exists: false, invalidSelector: true }; }
    }),
  }), [...selectors].slice(0, 8)).catch(() => ({ unavailable: true }));
}

// ---- 基础检查
const base = { blocking: [], warnings: [] };
const { context: c0, page: p0 } = await open(base);
const info = await p0.evaluate(() => {
  const text = (document.body?.innerText || '').trim();
  let visible = 0;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05) visible += 1;
  }
  return { text: text.slice(0, 200), chars: text.length, visible };
}).catch(() => ({ text: '', chars: 0, visible: 0 }));
const placeholder = (info.chars === 0 && info.visible < 3) || /^(loading|加载中|正在加载)[.。…\s]*$/i.test(info.text);
if (placeholder) base.blocking.push('页面只有占位内容(可见文字 "' + short(info.text, 40) + '",可见元素 ' + info.visible + ' 个)');
const screenshots = [];
const shot = async (page, name) => { const p = dir + '/' + name + '.png'; await page.screenshot({ path: p }).then(() => screenshots.push(p)).catch(() => {}); };
await shot(p0, 'base');
await c0.close();

// ---- 功能检查
const checks = [];
for (const check of spec.checks || []) {
  const sink = { blocking: [], warnings: [] };
  const { context, page } = await open(sink);
  const saved = {};
  let failed = null;
  const stepResults = [];
  for (let i = 0; i < check.steps.length && !failed; i += 1) {
    const s = check.steps[i];
    const loc = () => page.locator(s.selector).first();
    let r = { ok: true };
    try {
      switch (s.op) {
        case 'click': await loc().click({ timeout: T }); break;
        case 'fill': await loc().fill(String(s.value ?? ''), { timeout: T }); break;
        case 'press': if (s.selector) await loc().press(s.key, { timeout: T }); else await page.keyboard.press(s.key); break;
        case 'wait': await page.waitForTimeout(Math.min(Number(s.ms) || 300, 3000)); break;
        case 'reload': await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(400); break;
        case 'save': saved[s.name] = JSON.stringify(await evalJs(page, s.js)); break;
        case 'expectVisible': r = await until(page, async () => ({ ok: await loc().isVisible(), detail: '元素不可见: ' + s.selector })); break;
        case 'expectHidden': r = await until(page, async () => ({ ok: !(await loc().isVisible()), detail: '元素仍可见: ' + s.selector })); break;
        case 'expectText': r = await until(page, async () => {
          const t = s.selector ? await loc().innerText({ timeout: 1000 }) : await page.locator('body').innerText();
          return { ok: t.includes(s.contains), detail: '期望包含 "' + short(s.contains, 40) + '",实际 "' + short(t, 80) + '"' };
        }); break;
        case 'expectCount': r = await until(page, async () => {
          const n = await page.locator(s.selector).count();
          const ok = (s.equals == null || n === s.equals) && (s.min == null || n >= s.min) && (s.max == null || n <= s.max);
          return { ok, detail: s.selector + ' 数量为 ' + n };
        }); break;
        case 'expectTrue': r = await until(page, async () => ({ ok: !!(await evalJs(page, s.js)), detail: '表达式为假: ' + short(s.js, 80) })); break;
        case 'expectChanged': r = await until(page, async () => {
          if (!Object.hasOwn(saved, s.name)) return { ok: false, detail: '缺少同名 save 基准值: ' + s.name };
          const now = JSON.stringify(await evalJs(page, s.js));
          return { ok: now !== saved[s.name], detail: '值未变化(' + short(now, 60) + ')' };
        }); break;
        default: r = { ok: false, detail: '未知操作 ' + s.op };
      }
    } catch (e) { r = { ok: false, detail: short(e.message) }; }
    const observed = await snapshot(page, check.steps);
    stepResults.push({ index: i + 1, op: s.op, ok: r.ok,
      ...(s.op.startsWith('expect') ? { expected: s.op === 'expectTrue' ? 'true' : (s.contains ?? s.equals ?? s.min ?? 'condition'), actual: r.ok ? 'matched' : (r.detail || 'false') } : {}),
      observed });
    if (!r.ok) failed = '步骤 ' + (i + 1) + ' ' + s.op + ': ' + r.detail;
  }
  if (!failed && sink.blocking.length) failed = sink.blocking[0];
  if (failed) await shot(page, 'fail-' + check.id);
  checks.push({ id: check.id, status: failed ? 'fail' : 'pass', reason: failed || '', blocking: sink.blocking.slice(0, 3), warnings: sink.warnings.slice(0, 3), stepResults: failed ? stepResults : [] });
  await context.close();
}
await browser.close();
out({ base: { chars: info.chars, visible: info.visible, text: short(info.text, 80), placeholder, blocking: base.blocking.slice(0, 6), warnings: base.warnings.slice(0, 6) }, checks, screenshots });
`;

// ------------------------------------------------------------------ 检查脚本校验(防跳过/放宽)
const str = (v, max = 300) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const VACUOUS_JS = /^\s*(true|1|!0|!!1|"[^"]*"|'[^']*')\s*$/;

function validateStep(s, where) {
  if (!s || !VERIFY_OPS.includes(s.op)) throw new Error(`${where}: 不支持的操作 ${s?.op}`);
  const need = {
    click: ['selector'], fill: ['selector'], press: ['key'], save: ['name', 'js'], expectVisible: ['selector'],
    expectHidden: ['selector'], expectText: ['contains'], expectCount: ['selector'], expectTrue: ['js'], expectChanged: ['name', 'js'],
  }[s.op] || [];
  for (const k of need) if (!str(s[k], 500)) throw new Error(`${where}: ${s.op} 缺少 ${k}`);
  if ((s.op === 'expectTrue' || s.op === 'expectChanged') && VACUOUS_JS.test(s.js)) throw new Error(`${where}: 断言不能恒为真`);
  if (s.op === 'expectCount' && s.equals == null && !(s.min > 0) && s.max == null) throw new Error(`${where}: expectCount 需要 equals、min>0 或 max`);
  return s;
}

/**
 * 校验 Agent 提交的检查脚本。
 * - 每条非外部验收条件都必须有检查且至少一个断言(不能跳过);
 * - 检查只来自已保存的计划版本; Build 不能传入新检查;
 * - 不接受验收条件之外的 id(验收条件由平台保存,Agent 不能自行增删)。
 */
export function validateChecks(acceptance, checks) {
  if (!Array.isArray(acceptance) || !acceptance.length) throw new Error('缺少已确认的验收条件');
  if (!Array.isArray(checks)) throw new Error('checks 必须是数组');
  const ids = new Set(acceptance.map((a) => a.id));
  const byId = new Map();
  for (const [i, c] of checks.entries()) {
    if (!ids.has(c?.id)) throw new Error(`checks[${i}].id "${c?.id}" 不在验收条件中`);
    if (byId.has(c.id)) throw new Error(`checks 中 ${c.id} 重复`);
    if (!Array.isArray(c.steps) || !c.steps.length || c.steps.length > 25) throw new Error(`${c.id}: steps 需 1-25 步`);
    const saved = new Set();
    c.steps.forEach((s, j) => {
      validateStep(s, `${c.id}.steps[${j}]`);
      if (s.op === 'expectChanged' && !saved.has(s.name)) throw new Error(`${c.id}.steps[${j}]: expectChanged 前必须有同名 save`);
      if (s.op === 'save') saved.add(s.name);
    });
    byId.set(c.id, c);
  }
  for (const a of acceptance) {
    const c = byId.get(a.id);
    if (!c) {
      if (a.external) continue;
      throw new Error(`缺少验收条件 ${a.id} 的检查(不能跳过):${a.action} → ${a.expect}`);
    }
    const asserts = c.steps.filter((s) => ASSERT_OPS.includes(s.op)).length;
    if (!asserts) throw new Error(`${a.id} 没有任何断言,只检查按钮存在或可点击不算验收`);
  }
  return { checks: [...byId.values()] };
}

// ------------------------------------------------------------------ 执行
/** 每个沙箱只安装一次(标记文件 .ready);安装失败按「验收工具故障」上报。 */
export async function ensureBrowser(sandbox, sandboxId) {
  const home = (await sandbox.exec(sandboxId, 'printf %s "$HOME"', { timeoutMs: 20000 })).stdout.trim() || '/home/daytona';
  const dir = `${home}/.forge-verify`;
  const cmd = [
    `mkdir -p ${dir} && cd ${dir}`,
    `if [ ! -f .ready ]; then`,
    // npm init -y 会把隐藏目录名 .forge-verify 当包名，npm 会拒绝这个名称。
    `  printf '%s\\n' '{"name":"forge-verify","private":true}' > package.json &&`,
    `  npm install --no-audit --no-fund playwright-core@${PLAYWRIGHT_VERSION} >/dev/null &&`,
    `  (npx playwright-core install --with-deps chromium || npx playwright-core install chromium) && touch .ready;`,
    `fi; test -f .ready && echo READY`,
  ].join('\n');
  const r = await sandbox.exec(sandboxId, cmd, { timeoutMs: 600000 });
  if (!/READY/.test(r.stdout)) {
    const e = new Error(`浏览器验收环境安装失败: ${(r.stdout || r.stderr || '').slice(-300)}`);
    e.verifyToolError = true;
    e.timedOut = r.timedOut === true;
    throw e;
  }
  return dir;
}

export function parseRunnerOutput(stdout) {
  const idx = String(stdout || '').lastIndexOf(MARKER);
  if (idx < 0) return { toolError: `验收脚本无结构化输出: ${String(stdout || '').slice(-300)}` };
  try {
    return JSON.parse(stdout.slice(idx + MARKER.length).split('\n')[0]);
  } catch (e) {
    return { toolError: `验收结果无法解析: ${e.message}` };
  }
}

/** 在沙箱内执行验收;任何安装/运行故障都返回 { toolError },绝不当作通过。 */
export async function runVerification({ sandbox, sandboxId, checks, url = VERIFY_URL }) {
  try {
    const dir = await ensureBrowser(sandbox, sandboxId);
    const stamp = Date.now();
    await sandbox.writeFile(sandboxId, `${dir}/run.mjs`, RUNNER_SOURCE);
    await sandbox.writeFile(sandboxId, `${dir}/spec.json`, JSON.stringify({ url, checks, outDir: `${dir}/shots-${stamp}` }));
    const r = await sandbox.exec(sandboxId, `cd ${dir} && node run.mjs spec.json`, { timeoutMs: 240000 });
    if (r.timedOut) return { toolError: '验收脚本执行超时', timedOut: true };
    return parseRunnerOutput(r.stdout);
  } catch (error) {
    return { toolError: String(error?.message || error).slice(0, 300), ...(error?.timedOut ? { timedOut: true } : {}) };
  }
}

// ------------------------------------------------------------------ 结果分类与反馈
/** Browser evidence is separate from approved acceptance: failed checks are never relabelled verified. */
export function classifyResult(result, acceptance) {
  if (!result || result.toolError) return { kind: 'tool_error', toolError: result?.toolError || '验收工具无结果', items: [], base: null };
  const byId = new Map((result.checks || []).map((c) => [c.id, c]));
  const base = result.base || { blocking: ['缺少基础检查结果'], warnings: [] };
  const items = acceptance.map((a) => {
    const c = byId.get(a.id);
    const shared = { ...a, reason: c?.reason || '', stepResults: c?.stepResults || [] };
    if (a.external) return { ...shared, status: !c ? 'missing_config' : c.status === 'pass' ? 'verified' : 'unverifiable' };
    if (!c) return { ...shared, status: 'inconclusive', reason: '缺少检查结果' };
    if (c.blocking?.length) return { ...shared, status: 'blocker', reason: c.blocking[0] };
    if (c.status === 'pass') return { ...shared, status: 'verified' };
    // An explicit false assertion is evidence of unmet approved acceptance, even if
    // a composite expression does not reveal which subexpression was false.
    const failedStep = c.stepResults?.find((step) => !step.ok);
    const disabled = failedStep?.observed?.elements?.some((el) => el.disabled === true);
    if (a.severity === 'core' && disabled) return { ...shared, status: 'blocker' };
    const reason = String(c.reason || '');
    const explicitFailure = /表达式为假|期望包含|expectText.*实际|数量为|元素不可见|元素仍可见|值未变化/.test(reason)
      || failedStep?.actual === false || failedStep?.actual === 'false';
    if (explicitFailure) return { ...shared, status: a.severity === 'core' ? 'blocker' : 'warning' };
    // Locator errors, exceptions and missing observations do not establish a false assertion.
    return { ...shared, status: 'inconclusive' };
  });
  const hasBlocker = base.blocking?.length > 0 || items.some((i) => i.status === 'blocker');
  const hasUncertain = items.some((i) => ['inconclusive', 'missing_config', 'unverifiable'].includes(i.status));
  const hasWarning = items.some((i) => i.status === 'warning') || base.warnings?.length > 0;
  return { kind: hasBlocker ? 'blocker' : hasUncertain ? 'inconclusive' : hasWarning ? 'success_with_warnings' : 'passed',
    items, base, screenshots: result.screenshots || [] };
}

export function formatObservation(v, round, maxRounds) {
  if (v.kind === 'tool_error') return `浏览器验收环境故障，本次无法判断应用：${v.toolError}`;
  const heading = { passed: '验收全部通过。', blocker: '核心故障，任务不能标记完成。',
    inconclusive: '验收证据不足；当前版本可预览，但不能声称所有条件已验证。',
    success_with_warnings: '应用可预览，验收有警告。' }[v.kind];
  const lines = [heading, `第 ${round}/${maxRounds} 次浏览器验收`];
  for (const b of (v.base.blocking || []).slice(0, 3)) lines.push(`- 核心故障: ${b}`);
  for (const i of v.items) {
    const mark = { verified: '✓', warning: '警告', blocker: '阻断', inconclusive: '证据不足', missing_config: '缺少配置', unverifiable: '无法验证' }[i.status];
    lines.push(`- ${i.id} ${mark} ${i.action} → ${i.expect}${i.reason ? ` | ${i.reason}` : ''}`);
    if (i.status !== 'verified') {
      const failed = i.stepResults.find((step) => !step.ok);
      if (failed) lines.push(`  步骤 ${failed.index} ${failed.op}: expected=${JSON.stringify(failed.expected ?? null)}, actual=${JSON.stringify(failed.actual ?? null)}, observed=${JSON.stringify(failed.observed).slice(0, 450)}`);
    }
  }
  if (v.base.warnings?.length) lines.push(`非阻断警告 ${v.base.warnings.length} 条,例如: ${v.base.warnings[0]}`);
  if (v.kind === 'blocker') lines.push('保留代码和预览，等待用户选择修复或修订验收条件；不自动重试。');
  else if (v.kind !== 'passed') lines.push('可继续使用当前版本；若要修复，请提交新任务；验收定义有误则通过 Plan 修订后重新批准。未通过项没有被标记为已验证。');
  return lines.join('\n').slice(0, 3500);
}

/** 完成摘要:基于实际结果区分 已实现 / 已验证 / 未验证。 */
export function composeSummary(agentSummary, v) {
  const verified = v?.items?.filter((i) => i.status === 'verified') || [];
  const unverified = v?.items?.filter((i) => i.status !== 'verified') || [];
  return [
    `已实现(代理说明):${agentSummary}`,
    `已验证(浏览器实际执行):${verified.length ? verified.map((i) => `${i.id} ${i.expect}`).join(';') : '仅基础检查'}`,
    `未验证:${unverified.length ? unverified.map((i) => `${i.id} ${i.action}(${({ warning: '有警告', inconclusive: '证据不足', missing_config: '缺少外部服务配置', unverifiable: '无法验证', blocker: '核心故障' })[i.status] || '未通过'}${i.reason ? ': ' + i.reason.slice(0, 100) : ''})`).join(';') : '无'}`,
  ].join('\n');
}
