import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder';

const {
  DESIGN_MEMORY_KEY,
  designWarnings,
  parseDesign,
  renderDesignPrompt,
  renderDesignTokensCss,
  resolveDesign,
  wantsDesignChange,
} = await import('../src/design.js');
const { findMissingDependencies } = await import('../src/deps-check.js');
const { runBuild } = await import('../src/agent.js');
const { renderMemories } = await import('../src/memory.js');

export const TODO_DESIGN = {
  scenario: '个人日常待办,桌面与手机均可快速记录',
  style: '清爽简洁,浅色背景,单一强调色',
  layout: { type: 'single-column', description: '居中单列:标题、输入栏、任务列表、底部统计' },
  colors: {
    background: '#F7F7F5', surface: '#FFFFFF', text: '#1F2328', textMuted: '#5B636E',
    primary: '#2F5BD3', onPrimary: '#FFFFFF', border: '#E2E4E8', danger: '#B42318', success: '#1E7F4F',
  },
  typography: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', scale: { h1: '28px', h2: '18px', body: '16px', small: '13px' } },
  spacing: [4, 8, 12, 16, 24, 32],
  breakpoints: { mobile: 640, desktop: 1024 },
  states: ['empty', 'completed', 'hover', 'focus', 'disabled'],
};
const DASH_DESIGN = { ...TODO_DESIGN, scenario: '运营数据看板', layout: { type: 'dashboard-grid', description: '顶部 KPI 卡 + 图表网格' }, states: ['loading', 'error', 'hover', 'focus'] };

const task = (prompt) => ({ id: 't1', prompt });
function fakeDeps(outputs) {
  const writes = [];
  let i = 0;
  return { writes, calls: () => i, chat: async () => outputs[i++], upsertMemory: async (id, m) => writes.push({ id, ...m }) };
}

test('方案仅拒绝非法结构，低对比度保留且报告 warning', () => {
  assert.equal(parseDesign(JSON.stringify(TODO_DESIGN)).layout.type, 'single-column');
  assert.throws(() => parseDesign(JSON.stringify({ ...TODO_DESIGN, layout: { type: 'fancy' } })), /layout\.type/);
  const low = parseDesign(JSON.stringify({ ...TODO_DESIGN, colors: { ...TODO_DESIGN.colors, text: '#EEEEEE' } }));
  assert.equal(low.colors.text, '#EEEEEE');
  assert.match(designWarnings(low).join(' '), /text\/background/);
  assert.throws(() => parseDesign(JSON.stringify({ ...TODO_DESIGN, states: ['sparkle'] })), /states/);
  assert.throws(() => parseDesign('不是 JSON'), /没有 JSON/);
});

test('首次生成:写入 project 记忆 design_system(upsert)', async () => {
  const deps = fakeDeps([JSON.stringify(TODO_DESIGN)]);
  const { design, source } = await resolveDesign({ task: task('做一个待办应用'), memories: [], context: 'c', deps });
  assert.equal(source, 'generated');
  assert.equal(design.layout.type, 'single-column');
  assert.deepEqual(deps.writes.map((w) => [w.scope, w.key]), [['project', DESIGN_MEMORY_KEY]]);
  assert.deepEqual(JSON.parse(deps.writes[0].value), TODO_DESIGN);
});

test('校验失败走反馈重试,仍失败抛 DESIGN_INVALID,不静默使用默认值', async () => {
  const bad = JSON.stringify({ ...TODO_DESIGN, spacing: null });
  const deps = fakeDeps([bad, bad]);
  await assert.rejects(resolveDesign({ task: task('待办'), memories: [], context: 'c', deps }), (e) => e.code === 'DESIGN_INVALID');
  assert.equal(deps.writes.length, 0);
  assert.equal(deps.calls(), 2);
});

test('真实失败配色及非理想间距只生成一次，保存原值而非重调或自动改色', async () => {
  for (const primary of ['#4caf50', '#2196f3']) {
    const original = { ...TODO_DESIGN, spacing: [8, 4], colors: { ...TODO_DESIGN.colors, primary, onPrimary: '#ffffff' } };
    const deps = fakeDeps([JSON.stringify(original)]);
    const result = await resolveDesign({ task: task('贪吃蛇'), memories: [], context: 'c', deps });
    assert.equal(deps.calls(), 1);
    assert.deepEqual(result.design, original);
    assert.equal(result.warnings.length, 2);
    const cached = await resolveDesign({ task: task('继续'), memories: [{ scope: 'project', key: DESIGN_MEMORY_KEY, value: JSON.stringify(original) }], context: 'c', deps });
    assert.equal(cached.source, 'memory');
    assert.equal(deps.calls(), 1);
  }
});

test('保存设计失败保持原始存储错误，不触发重新生成或 DESIGN_INVALID', async () => {
  const deps = fakeDeps([JSON.stringify(TODO_DESIGN)]);
  const failure = Object.assign(new Error('storage failed'), { code: 'SUPABASE_STATE' });
  deps.upsertMemory = async () => { throw failure; };
  await assert.rejects(resolveDesign({ task: task('待办'), memories: [], context: 'c', deps }), (e) => e === failure);
  assert.equal(deps.calls(), 1);
});

test('增量修改:注入已有方案,不调用模型、不覆盖记忆', async () => {
  const memories = [{ scope: 'project', key: DESIGN_MEMORY_KEY, value: JSON.stringify(TODO_DESIGN) }];
  const deps = fakeDeps([]);
  const { design, source } = await resolveDesign({ task: task('给待办加一个截止日期字段'), memories, context: 'c', deps });
  assert.equal(source, 'memory');
  assert.deepEqual(design, TODO_DESIGN);
  assert.equal(deps.calls(), 0);
  assert.equal(deps.writes.length, 0);
});

test('用户明确要求调整设计时才覆盖记忆', async () => {
  const memories = [{ scope: 'project', key: DESIGN_MEMORY_KEY, value: JSON.stringify(TODO_DESIGN) }];
  const changed = { ...TODO_DESIGN, colors: { ...TODO_DESIGN.colors, primary: '#0F766E' } };
  const deps = fakeDeps([JSON.stringify(changed)]);
  const { source } = await resolveDesign({ task: task('把配色换成绿色系'), memories, context: 'c', deps });
  assert.equal(source, 'updated');
  assert.equal(JSON.parse(deps.writes[0].value).colors.primary, '#0F766E');
  assert.ok(wantsDesignChange('请调整一下布局'));
  assert.ok(wantsDesignChange('改成深色模式'));
  assert.ok(!wantsDesignChange('新增删除确认'));
  assert.ok(!wantsDesignChange('修复添加按钮不生效的问题'));
});

test('不同需求产生不同布局类型(固定模型返回模拟)', async () => {
  const a = await resolveDesign({ task: task('待办清单'), memories: [], context: 'c', deps: fakeDeps([JSON.stringify(TODO_DESIGN)]) });
  const b = await resolveDesign({ task: task('数据看板'), memories: [], context: 'c', deps: fakeDeps([JSON.stringify(DASH_DESIGN)]) });
  assert.notEqual(a.design.layout.type, b.design.layout.type);
  assert.equal(b.design.layout.type, 'dashboard-grid');
});

test('Build 提示词包含设计方案;tokens CSS 含语义变量;记忆渲染不重复注入', async () => {
  const prompt = renderDesignPrompt(TODO_DESIGN);
  let systemSeen = '';
  const deps = {
    chat: async (h) => { systemSeen = h[0].content; return JSON.stringify({ tool: 'build', args: {} }); },
    appendStep: async () => {}, updateTask: async () => {}, updateProject: async () => {}, upsertFile: async () => {}, deleteFile: async () => {},
  };
  const sandbox = { workdir: '/w', exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }), checkProcess: async () => false, listFiles: async () => [], readFile: async () => { throw new Error('x'); } };
  await assert.rejects(runBuild({ id: 't', tool_steps: 0, fix_rounds: 0 }, {}, sandbox, 's', 'ctx', deps, prompt, [{ id: 'A1', action: '打开页面', expect: '看到内容', external: false, steps: [{ op: 'expectText', selector: 'main', contains: '内容' }] }]));
  assert.match(systemSeen, /【设计方案\(项目约定,必须遵守\)】/);
  assert.match(systemSeen, /single-column/);
  const css = renderDesignTokensCss(TODO_DESIGN);
  assert.match(css, /--color-primary: #2F5BD3;/);
  assert.match(css, /--space-6: 32px;/);
  const rendered = renderMemories([{ scope: 'project', key: DESIGN_MEMORY_KEY, value: '{}' }, { scope: 'project', key: 'x', value: 'y' }]);
  assert.ok(!rendered.includes(DESIGN_MEMORY_KEY));
});

test('依赖声明检查:import 未声明被拦截,已声明/相对路径通过', () => {
  const pkg = JSON.stringify({ dependencies: { react: '^18' } });
  const { missing } = findMissingDependencies(pkg, [
    { path: 'src/App.tsx', content: "import { Trash2 } from 'lucide-react';\nimport React from 'react';\nimport './x.css';\nimport a from '@scope/pkg/sub';" },
  ]);
  assert.deepEqual(missing.map((m) => m.name), ['lucide-react', '@scope/pkg']);
  const ok = findMissingDependencies(JSON.stringify({ dependencies: { react: '^18', 'lucide-react': '^0.4' } }), [
    { path: 'src/App.tsx', content: "import { Trash2 } from 'lucide-react';" },
  ]);
  assert.equal(ok.missing.length, 0);
});

test('build 工具在构建前拦截未声明依赖,不执行 npm 构建', async () => {
  const steps = [];
  const execs = [];
  const deps = {
    checkLease: async () => {},
    chat: async () => JSON.stringify({ tool: 'build', args: {} }),
    appendStep: async (_t, s) => steps.push(s), updateTask: async () => {}, updateProject: async () => {}, upsertFile: async () => {}, deleteFile: async () => {},
  };
  const files = { 'package.json': JSON.stringify({ dependencies: { react: '^18' } }), 'src/App.tsx': "import { Plus } from 'lucide-react';" };
  const sandbox = {
    workdir: '/w',
    exec: async (_i, c) => { execs.push(c); return { exitCode: 0, stdout: '', stderr: '' }; },
    checkProcess: async () => false,
    listFiles: async () => Object.keys(files).map((p) => `/w/${p}`),
    readFile: async (_i, p) => files[p],
  };
  await assert.rejects(runBuild({ id: 't', tool_steps: 0, fix_rounds: 0 }, {}, sandbox, 's', 'ctx', deps, '', [{ id: 'A1', action: '打开页面', expect: '看到内容', external: false, steps: [{ op: 'expectText', selector: 'main', contains: '内容' }] }]), (e) => e.code === 'AGENT_STALLED');
  assert.match(steps.find((step) => step.event === 'finished')?.observation ?? '', /lucide-react\(src\/App\.tsx\)/);
  assert.equal(execs.length, 0);
});
