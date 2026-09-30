import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChecks, classifyResult, parseRunnerOutput, ensureBrowser, RUNNER_SOURCE } from '../src/verify.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const acceptance = [{ id: 'A1', action: '添加任务', expect: '列表新增任务', external: false }];
const base = { blocking: [], warnings: [] };

test('隐藏的验收目录写入有效包名，安装前不运行会失败的 npm init', async () => {
  const home = mkdtempSync(join(tmpdir(), 'forge-verify-'));
  try {
    const sandbox = { exec: async (_id, command) => {
      if (command === 'printf %s "$HOME"') return { stdout: home, exitCode: 0 };
      const local = command
        .replace('npm install --no-audit --no-fund playwright-core@1.52.0 >/dev/null', 'true')
        .replace('npx playwright-core install --with-deps chromium || npx playwright-core install chromium', 'true');
      const stdout = execFileSync('bash', ['-lc', local], { encoding: 'utf8' });
      return { stdout, exitCode: 0 };
    } };
    assert.equal(await ensureBrowser(sandbox, 'test'), join(home, '.forge-verify'));
    assert.equal(JSON.parse(readFileSync(join(home, '.forge-verify', 'package.json'), 'utf8')).name, 'forge-verify');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('只有 Loading 占位内容时,即使构建和页面加载成功也不能通过验收', () => {
  const result = classifyResult({ base: { blocking: ['页面只有占位内容'], warnings: [] }, checks: [{ id: 'A1', status: 'pass' }] }, acceptance);
  assert.equal(result.kind, 'blocker');
});

test('未记录明确断言结果时按证据不足处理，绝不伪称已验证', () => {
  const failed = classifyResult({ base, checks: [{ id: 'A1', status: 'fail', reason: '任务未出现' }] }, acceptance);
  assert.equal(failed.kind, 'inconclusive');
  assert.equal(failed.items[0].status, 'inconclusive');
  assert.equal(classifyResult({ base, checks: [{ id: 'A1', status: 'pass' }] }, acceptance).kind, 'passed');
});

test('浏览器工具故障与应用失败分开报告', () => {
  assert.equal(classifyResult({ toolError: 'chromium missing' }, acceptance).kind, 'tool_error');
  assert.equal(parseRunnerOutput('no marker').toolError.includes('无结构化输出'), true);
});

test('外部服务需求未验证时明确标记证据不足', () => {
  const external = [{ id: 'A1', action: '提交订单', expect: '创建订单', external: true }];
  const result = classifyResult({ base, checks: [] }, external);
  assert.equal(result.kind, 'inconclusive');
  assert.equal(result.items[0].status, 'missing_config');
});

test('expectChanged 必须先保存同名旧值', () => {
  assert.throws(() => validateChecks(acceptance, [{ id: 'A1', steps: [{ op: 'expectChanged', name: 'x', js: 'document.body.textContent' }] }]), /必须有同名 save/);
  assert.doesNotThrow(() => validateChecks(acceptance, [{ id: 'A1', steps: [
    { op: 'save', name: 'x', js: 'document.body.textContent' },
    { op: 'click', selector: 'button' },
    { op: 'expectChanged', name: 'x', js: 'document.body.textContent' },
  ] }]));
});

test('缺少验收条件或检查不得通过', () => {
  assert.throws(() => validateChecks([], []), /缺少已确认/);
  assert.throws(() => validateChecks(acceptance, []), /缺少验收条件 A1/);
});

test('细节检查的明确 expectTrue=false 是警告；运行时崩溃仍阻断', () => {
  const uncertain = classifyResult({ base, checks: [{ id: 'A1', status: 'fail', reason: '步骤 3 expectTrue: 表达式为假',
    stepResults: [{ index: 1, op: 'click', ok: true, observed: { elements: [] } },
      { index: 3, op: 'expectTrue', ok: false, expected: 'true', actual: 'false', observed: { elements: [{ selector: '[data-testid=steps]', text: '0' }] } }] }] }, acceptance);
  assert.equal(uncertain.kind, 'success_with_warnings');
  assert.equal(uncertain.items[0].status, 'warning');
  assert.equal(uncertain.items[0].stepResults[1].observed.elements[0].text, '0');
  assert.equal(classifyResult({ base, checks: [{ id: 'A1', status: 'fail', reason: 'x', blocking: ['页面异常: crash'] }] }, acceptance).kind, 'blocker');
});

test('sandbox runner source parses after adding per-step diagnostics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-runner-check-'));
  try {
    const path = join(dir, 'runner.mjs');
    writeFileSync(path, RUNNER_SOURCE);
    execFileSync(process.execPath, ['--check', path]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('计划明确标记的核心操作有客观失败证据才阻断；旧计划仍保守分类', () => {
  const objective = { base, checks: [{ id: 'A1', status: 'fail', reason: '步骤 3 expectText: 期望任务出现,实际为空',
    stepResults: [{ index: 3, op: 'expectText', ok: false, observed: { elements: [{ selector: '#list', text: '' }] } }] }] };
  assert.equal(classifyResult(objective, [{ ...acceptance[0], severity: 'core' }]).kind, 'blocker');
  assert.equal(classifyResult(objective, acceptance).kind, 'success_with_warnings');
  const composite = { ...objective, checks: [{ ...objective.checks[0], reason: '步骤 3 expectTrue: 表达式为假' }] };
  assert.equal(classifyResult(composite, [{ ...acceptance[0], severity: 'core' }]).kind, 'blocker');
  assert.equal(classifyResult(composite, [{ ...acceptance[0], severity: 'detail' }]).kind, 'success_with_warnings');
});

test('选择器找不到与断言执行异常属于证据不足，不能当作明确 false', () => {
  const uncertain = classifyResult({ base, checks: [{ id: 'A1', status: 'fail', reason: '步骤 1 click: locator.click: Timeout 5000ms exceeded',
    stepResults: [{ index: 1, op: 'click', ok: false, observed: { elements: [{ selector: '#missing', exists: false }] } }] }] },
  [{ ...acceptance[0], severity: 'core' }]);
  assert.equal(uncertain.kind, 'inconclusive');
  assert.equal(uncertain.items[0].status, 'inconclusive');
});
