import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChecks, classifyResult, parseRunnerOutput, ensureBrowser } from '../src/verify.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  assert.equal(result.kind, 'app_failed');
});

test('核心交互失败不能完成;通过后才是 passed', () => {
  const failed = classifyResult({ base, checks: [{ id: 'A1', status: 'fail', reason: '任务未出现' }] }, acceptance);
  assert.equal(failed.kind, 'app_failed');
  assert.equal(classifyResult({ base, checks: [{ id: 'A1', status: 'pass' }] }, acceptance).kind, 'passed');
});

test('浏览器工具故障与应用失败分开报告', () => {
  assert.equal(classifyResult({ toolError: 'chromium missing' }, acceptance).kind, 'tool_error');
  assert.equal(parseRunnerOutput('no marker').toolError.includes('无结构化输出'), true);
});

test('外部服务需求未验证不能标记应用成功', () => {
  const external = [{ id: 'A1', action: '提交订单', expect: '创建订单', external: true }];
  const result = classifyResult({ base, checks: [] }, external);
  assert.equal(result.kind, 'blocked');
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
