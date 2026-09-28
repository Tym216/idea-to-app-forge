// 用 Worker 真实的脚手架与 renderDesignTokensCss 生成 fixture 基础文件(不调用模型)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'x';
const { SCAFFOLD_FILES } = await import('../src/scaffold.js');
const { renderDesignTokensCss, validateDesign } = await import('../src/design.js');
const design = validateDesign(JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./todo-design.json', import.meta.url), 'utf8')));
const root = new URL('./todo-app/', import.meta.url).pathname;
const files = { ...SCAFFOLD_FILES, 'src/design-tokens.css': renderDesignTokensCss(design) };
delete files['src/App.tsx']; delete files['src/index.css'];
const pkg = JSON.parse(files['package.json']); pkg.dependencies['lucide-react'] = '^0.460.0'; files['package.json'] = JSON.stringify(pkg, null, 2);
for (const [p, c] of Object.entries(files)) { await mkdir(dirname(join(root, p)), { recursive: true }); await writeFile(join(root, p), c); }
console.log('fixture scaffold written', Object.keys(files));
