/**
 * 构建前依赖声明检查:源码 import 的第三方包必须出现在 package.json 中,
 * 否则在 build 之前就拦截并提示模型修正,而不是等构建失败。
 */
const IMPORT_RE = /(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

export function packageNameOf(spec) {
  if (!spec || /^(\.|\/|node:|virtual:|~|@\/)/.test(spec)) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function findMissingDependencies(pkgText, sources) {
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return { missing: [], error: 'package.json 不是合法 JSON' };
  }
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  const missing = new Map();
  for (const { path, content } of sources) {
    for (const match of content.matchAll(IMPORT_RE)) {
      const name = packageNameOf(match[1] || match[2] || match[3]);
      if (name && !declared.has(name)) {
        if (!missing.has(name)) missing.set(name, new Set());
        missing.get(name).add(path);
      }
    }
  }
  return { missing: [...missing].map(([name, files]) => ({ name, files: [...files] })), error: '' };
}

/** 读取沙箱内 package.json 与 src 源码做检查;返回拦截文本,空串表示通过。 */
export async function checkSandboxDependencies(sandbox, sandboxId) {
  let pkgText;
  try {
    pkgText = await sandbox.readFile(sandboxId, 'package.json');
  } catch {
    return '';
  }
  const paths = await sandbox.listFiles(sandboxId, sandbox.workdir).catch(() => []);
  const prefix = `${sandbox.workdir}/`;
  const rel = paths.map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p));
  const sources = [];
  for (const path of rel.filter((p) => /^src\/.+\.(tsx?|jsx?)$/.test(p))) {
    try {
      sources.push({ path, content: await sandbox.readFile(sandboxId, path) });
    } catch {
      // 读不到的文件交给构建本身报错
    }
  }
  const { missing, error } = findMissingDependencies(pkgText, sources);
  if (error) return `构建前检查失败: ${error}`;
  if (!missing.length) return '';
  return [
    '构建前依赖检查未通过:以下包被 import 但未在 package.json 声明:',
    ...missing.map((m) => `- ${m.name}(${m.files.join(', ')})`),
    '请先 write_file 更新 package.json 的 dependencies,再 run_command 执行 npm install,然后重新 build。',
  ].join('\n');
}
