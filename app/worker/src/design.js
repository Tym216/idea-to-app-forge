import { parseJson } from './llm.js';

/**
 * 轻量设计方案:由同一个 Agent 在生成代码前产出结构化 JSON,
 * 校验后保存为 project 记忆(key=design_system),并落地为 src/design-tokens.css。
 */
export const DESIGN_MEMORY_KEY = 'design_system';
export const DESIGN_TOKENS_PATH = 'src/design-tokens.css';
export const LAYOUTS = [
  'single-column',
  'sidebar-main',
  'card-grid',
  'dashboard-grid',
  'form-wizard',
  'split-view',
  'landing-sections',
];
export const COLOR_TOKENS = ['background', 'surface', 'text', 'textMuted', 'primary', 'onPrimary', 'border', 'danger', 'success'];
export const STATES = ['empty', 'loading', 'error', 'completed', 'selected', 'hover', 'focus', 'disabled'];
const TYPE_SCALE = ['h1', 'h2', 'body', 'small'];

const DESIGN_GEN_PROMPT = `你是产品设计师。根据用户需求为即将生成的 React 应用制定轻量设计方案,只输出一个 JSON 对象:
{"scenario":"目标场景与用户","style":"视觉风格一句话","layout":{"type":"${LAYOUTS.join('|')}","description":"页面结构说明"},
"colors":{${COLOR_TOKENS.map((t) => `"${t}":"#RRGGBB"`).join(',')}},
"typography":{"fontFamily":"CSS font-family","scale":{"h1":"28px","h2":"18px","body":"16px","small":"13px"}},
"spacing":[4,8,12,16,24,32],"breakpoints":{"mobile":640,"desktop":1024},
"states":["只列需求真正用到的交互状态,取值 ${STATES.join('/')}"]}
规则:
- layout.type 必须按需求选择:简单清单用 single-column,数据监控用 dashboard-grid,多步录入用 form-wizard,浏览集合用 card-grid,导航+内容用 sidebar-main 等;不要所有应用都用同一种。
- text/background 与 onPrimary/primary 的对比度必须 ≥ 4.5:1。
- 只能使用系统字体栈或 CSS 通用字体,不引入外部字体或素材服务。
- 不要为装饰添加与需求无关的功能或页面。`;

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Only unusable structure blocks execution; quality is reported separately. */
export function validateDesign(design) {
  if (!design || typeof design !== 'object' || Array.isArray(design)) {
    throw new Error('设计方案校验失败: 必须是 JSON 对象');
  }
  const errors = [];
  for (const key of ['scenario', 'style']) {
    if (typeof design[key] !== 'string' || !design[key].trim()) errors.push(`${key} 必须是非空字符串`);
  }
  if (!LAYOUTS.includes(design.layout?.type)) errors.push(`layout.type 必须是 ${LAYOUTS.join('/')} 之一`);
  if (typeof design.layout?.description !== 'string' || !design.layout.description.trim()) {
    errors.push('layout.description 必须是非空字符串');
  }
  const hex = /^#[0-9a-fA-F]{6}$/;
  const badColors = COLOR_TOKENS.filter((t) => !hex.test(design.colors?.[t] ?? ''));
  if (badColors.length) {
    errors.push(`colors.${badColors.join('/')} 必须是 #RRGGBB`);
  }
  if (typeof design.typography?.fontFamily !== 'string' || !design.typography.fontFamily.trim()) {
    errors.push('typography.fontFamily 必须是非空字符串');
  }
  const badScale = TYPE_SCALE.filter((k) => !/^\d+(\.\d+)?(px|rem)$/.test(design.typography?.scale?.[k] ?? ''));
  if (badScale.length) errors.push(`typography.scale.${badScale.join('/')} 必须形如 16px 或 1rem`);
  const sp = design.spacing;
  if (!Array.isArray(sp) || !sp.length || !sp.every(Number.isFinite)) {
    errors.push('spacing 必须是非空数值数组');
  }
  const bp = design.breakpoints;
  if (!Number.isFinite(bp?.mobile) || !Number.isFinite(bp?.desktop) || bp.mobile >= bp.desktop) {
    errors.push('breakpoints 需要 mobile < desktop 的数值');
  }
  if (!Array.isArray(design.states) || !design.states.length || !design.states.every((s) => STATES.includes(s))) {
    errors.push(`states 必须是 ${STATES.join('/')} 的非空子集`);
  }
  if (errors.length) throw new Error(`设计方案校验失败: ${errors.join('; ')}`);
  return design;
}

export function designWarnings(design) {
  const warnings = [];
  for (const [text, background] of [['text', 'background'], ['onPrimary', 'primary']]) {
    const ratio = contrastRatio(design.colors[text], design.colors[background]);
    if (ratio < 4.5) warnings.push(`${text}/${background} 对比度 ${ratio.toFixed(2)}，低于建议的 4.5；保留配色继续`);
  }
  if (design.spacing.length < 4 || !design.spacing.every((n, i, values) => n > 0 && (!i || n > values[i - 1]))) {
    warnings.push('间距数量或递增关系不理想；保留方案继续');
  }
  return warnings;
}

export function parseDesign(raw) {
  return validateDesign(parseJson(raw));
}

/** 用户是否明确要求调整设计(风格/配色/布局/字体/主题等)。 */
export function wantsDesignChange(prompt = '') {
  return (
    /(换|改|调整|更换|重新设计|修改|变更|切换|重做).{0,8}(风格|配色|颜色|主题|布局|字体|设计|样式|排版|色调|视觉)/.test(prompt) ||
    /(风格|配色|颜色|主题|布局|字体|设计|样式|排版|色调|视觉).{0,4}(换成|改成|改为|换为|调整|更换|重新设计|重做)/.test(prompt) ||
    /(深色模式|暗色模式|浅色模式|redesign|restyle|dark mode|new (color|layout|theme))/i.test(prompt)
  );
}

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function renderDesignTokensCss(design) {
  const lines = [
    '/* 由 Forge 设计方案自动生成(project 记忆 design_system)。调整设计请在需求中明确说明。 */',
    ':root {',
    ...COLOR_TOKENS.map((t) => `  --color-${kebab(t)}: ${design.colors[t]};`),
    `  --font-family: ${design.typography.fontFamily};`,
    ...TYPE_SCALE.map((k) => `  --font-${k}: ${design.typography.scale[k]};`),
    ...design.spacing.map((n, i) => `  --space-${i + 1}: ${n}px;`),
    `  --bp-mobile: ${design.breakpoints.mobile}px;`,
    `  --bp-desktop: ${design.breakpoints.desktop}px;`,
    '}',
    'body {',
    '  margin: 0;',
    '  background: var(--color-background);',
    '  color: var(--color-text);',
    '  font-family: var(--font-family);',
    '  font-size: var(--font-body);',
    '}',
    '',
  ];
  return lines.join('\n');
}

export function renderDesignPrompt(design) {
  return [
    '【设计方案(项目约定,必须遵守)】',
    JSON.stringify(design),
    '落实要求:',
    `- 页面布局必须采用 ${design.layout.type}:${design.layout.description}`,
    `- ${DESIGN_TOKENS_PATH} 已由系统生成,src/main.tsx 必须 import './design-tokens.css';颜色/字号/间距只用 var(--color-*) / var(--font-*) / var(--space-*),不要硬编码其他颜色。`,
    `- 响应式:@media (max-width: ${design.breakpoints.mobile}px) 为手机布局,≥ ${design.breakpoints.desktop}px 为桌面布局。`,
    `- 只实现需求用到的交互状态:${design.states.join(', ')};焦点状态需可见。`,
    '- 不要为装饰添加与需求无关的功能或页面;不引入外部字体、图片或素材服务。',
    '- 如使用组件库或图标(如 lucide-react),必须写入 package.json dependencies 并 npm install。',
  ].join('\n');
}

/**
 * 决定本轮的设计方案:
 * - 已有设计约定且用户未明确要求调整 → 直接复用,不调用模型、不覆盖记忆
 * - 无约定,或用户明确要求调整 → 模型生成(调整时以原方案为基础),校验失败先反馈重试一次,仍失败抛 DESIGN_INVALID
 */
export async function resolveDesign({ task, memories, context, deps }) {
  const existing = memories.find((m) => m.scope === 'project' && m.key === DESIGN_MEMORY_KEY);
  const change = wantsDesignChange(task.prompt);
  let previous = null;
  if (existing) {
    try {
      previous = validateDesign(JSON.parse(existing.value));
    } catch {
      previous = null;
    }
    if (previous && !change) return { design: previous, source: 'memory', warnings: designWarnings(previous) };
  }

  const system = previous
    ? `${DESIGN_GEN_PROMPT}\n用户明确要求调整设计。以下是现有方案,只修改用户要求调整的部分,其余保持不变:\n${JSON.stringify(previous)}`
    : DESIGN_GEN_PROMPT;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: context },
  ];

  let lastError;
  let design;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await deps.chat(messages, { json: true, temperature: 0.3, taskId: task.id, purpose: 'design', contextParts: { user: task.contextParts } });
    try {
      design = parseDesign(raw);
      break;
    } catch (error) {
      lastError = error;
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: `设计方案无效(${String(error.message || error)}),请修正后只输出一个 JSON 对象。` });
    }
  }
  if (design) {
    // Persistence failures must not request another design or become DESIGN_INVALID.
    await deps.upsertMemory(task.id, { scope: 'project', key: DESIGN_MEMORY_KEY, value: JSON.stringify(design), weight: 10 });
    return { design, source: previous ? 'updated' : 'generated', warnings: designWarnings(design) };
  }
  const error = new Error(`DESIGN_INVALID: ${String(lastError?.message || lastError)}`);
  error.code = 'DESIGN_INVALID';
  throw error;
}
