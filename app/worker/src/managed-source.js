import { createHash } from 'node:crypto';
import path from 'node:path';

export const MANIFEST_VERSION = 1;
export const SOURCE_LIMITS = { files: 2000, fileBytes: 1024 * 1024, bytes: 8 * 1024 * 1024 };
const ROOT_RUNTIME = new Set(['dist', 'build', 'out', '.vite', '.cache', '.next', '.turbo', 'coverage', 'logs', 'tmp', 'temp', 'test-results', 'playwright-report', 'screenshots', 'videos']);
export const sourceError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function normalizeSourcePath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 240 || /[\x00-\x1f\x7f\\]/.test(value) || Buffer.from(value).toString('utf8') !== value
    || path.posix.isAbsolute(value) || /^[A-Za-z]:|^~/.test(value) || value.split('/').includes('..')) {
    throw sourceError('SOURCE_PATH', '必须是项目内的 POSIX 相对路径');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized.endsWith('/')) throw sourceError('SOURCE_PATH', '不能把目录当文件');
  return normalized;
}

export function isManagedPath(value) {
  const normalized = normalizeSourcePath(value), parts = normalized.split('/'), name = parts.at(-1);
  if (ROOT_RUNTIME.has(parts[0]) || parts.some((p) => p === 'node_modules' || p === '.git' || p.startsWith('.forge-'))) return false;
  if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') return false;
  return true;
}

/** Full text manifest; fail closed on duplicates/binary/limits, never return a prefix. */
export function sourceManifest(rows, limits = SOURCE_LIMITS) {
  const files = [], seen = new Set();
  let total = 0;
  for (const row of rows) {
    const p = normalizeSourcePath(row.path);
    if (row.deleted || !isManagedPath(p)) continue;
    if (seen.has(p)) throw sourceError('SOURCE_DUPLICATE', p);
    if (row.symlink || (row.type && row.type !== 'file')) throw sourceError('SOURCE_TYPE', `${p} 不是普通文件`);
    if (typeof row.content !== 'string' || row.content.includes('\0') || Buffer.from(row.content).toString('utf8') !== row.content) {
      throw sourceError('SOURCE_ENCODING', `${p} 不是支持的 UTF-8 文本源码`);
    }
    seen.add(p);
    const size = Buffer.byteLength(row.content);
    total += size;
    if (size > limits.fileBytes || total > limits.bytes || files.length + 1 > limits.files) throw sourceError('SOURCE_LIMIT', '源码清单超限，未生成截断 manifest');
    files.push({ path: p, content: row.content, hash: sha256(row.content), bytes: size });
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { schema: MANIFEST_VERSION, complete: true, files, code_hash: sha256(JSON.stringify(files.map((f) => [f.path, f.hash]))) };
}

export function sourceDiff(before, after) {
  const a = new Map(before.files.map((f) => [f.path, f])), b = new Map(after.files.map((f) => [f.path, f]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap((p) => {
    const old = a.get(p), next = b.get(p);
    return old?.hash === next?.hash ? [] : [{ operation: next ? 'write' : 'delete', path: p,
      before_hash: old?.hash ?? null, after_hash: next?.hash ?? null, ...(next ? { content: next.content } : {}) }];
  });
}

export function applySourceChanges(before, changes) {
  const files = new Map(before.files.map((f) => [f.path, f.content])), seen = new Set();
  for (const c of changes) {
    const p = normalizeSourcePath(c.path);
    if (!isManagedPath(p) || seen.has(p) || !['write', 'delete'].includes(c.operation)) throw sourceError('SOURCE_CHANGE', `不支持的修改 ${p}`);
    seen.add(p);
    if (c.operation === 'delete') files.delete(p);
    else {
      if (typeof c.content !== 'string') throw sourceError('SOURCE_CHANGE', `${p} 缺少完整内容`);
      files.set(p, c.content);
    }
  }
  return sourceManifest([...files].map(([path, content]) => ({ path, content })));
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const fingerprint = (value) => sha256(JSON.stringify(canonical(value)));

/** Accept validity inputs only: transient execution provenance never affects reuse. */
export function buildFingerprint({ command, installCommand, nodeVersion, npmVersion, platform, arch, environmentHash }) {
  return fingerprint({ schema: 1, command, installCommand, nodeVersion, npmVersion, platform, arch, environmentHash });
}

export function verifyFingerprint(acceptance, { runnerHash, playwrightVersion, viewport = { width: 1280, height: 800 }, timeoutMs = 5000, buildBasis = null } = {}) {
  const checks = acceptance.map((a) => ({ id: a.id, external: a.external === true, severity: a.severity || 'detail', steps: a.steps || [] }));
  return fingerprint({ schema: 1, checks, runnerHash, playwrightVersion, viewport, timeoutMs, buildBasis, isolation: 'fresh-context-per-check' });
}

export function evidenceValid(evidence, { revision, codeHash, basisFingerprint }) {
  return !!evidence && typeof basisFingerprint === 'string' && !!basisFingerprint && evidence.workspace_revision === revision && evidence.code_hash === codeHash
    && evidence.basis_fingerprint === basisFingerprint;
}

export function checkpointReady(workspace, build, verify) {
  return workspace.state === 'confirmed' && !workspace.writer_token && !workspace.writer
    && evidenceValid(build, { revision: workspace.revision, codeHash: workspace.code_hash, basisFingerprint: workspace.build_fingerprint })
    && build.status === 'passed'
    && evidenceValid(verify, { revision: workspace.revision, codeHash: workspace.code_hash, basisFingerprint: workspace.verify_fingerprint })
    && ['passed', 'success_with_warnings', 'inconclusive'].includes(verify.status);
}
