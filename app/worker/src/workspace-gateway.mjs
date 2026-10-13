import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { sourceManifest, sourceDiff, isManagedPath, normalizeSourcePath, sha256 } from './managed-source.mjs';

// Executed under flock on a stable inode. All late operations check a monotonic epoch.
const spec = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
if ((await fs.lstat(spec.root)).isSymbolicLink()) throw new Error('SOURCE_ROOT_SYMLINK');
const root = await fs.realpath(spec.root);
const dir = spec.privateDir || path.join(root, '.forge-workspace');
await fs.mkdir(dir, { recursive: true });
if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error('SOURCE_SYMLINK');
const fenceFile = path.join(dir, 'fence.json');
async function fence() { return JSON.parse(await fs.readFile(fenceFile, 'utf8').catch(() => '{}')); }
async function atomic(p, content) {
  const tmp = path.join(dir, `staging-${spec.operation_id}-${sha256(p)}.tmp`);
  await fs.writeFile(tmp, content, { flag: 'w' });
  await fs.rename(tmp, p);
}
async function scan() {
  const rows = []; let totalBytes = 0;
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const p = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isManagedPath(p)) continue;
      if (entry.isSymbolicLink()) throw new Error(`SOURCE_SYMLINK: ${p}`);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) {
        const size = (await fs.stat(path.join(root, p))).size;
        totalBytes += size;
        if (size > 1048576 || totalBytes > 8388608 || rows.length >= 2000) throw new Error('SOURCE_LIMIT');
        const data = await fs.readFile(path.join(root, p));
        rows.push({ path: p, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) });
      } else throw new Error(`SOURCE_TYPE: ${p}`);
    }
  }
  await walk();
  return sourceManifest(rows);
}
async function checkFence() {
  const current = await fence();
  if (current.token !== spec.token || current.epoch !== spec.epoch || current.retired) throw new Error('WORKSPACE_FENCE_LOST');
}
async function safePath(p) {
  p = normalizeSourcePath(p);
  if (!isManagedPath(p)) throw new Error('SOURCE_PATH');
  let parent = root;
  for (const part of p.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    await fs.mkdir(parent).catch((e) => { if (e.code !== 'EEXIST') throw e; });
    if (!(await fs.lstat(parent)).isDirectory()) throw new Error('SOURCE_PARENT_TYPE');
  }
  const target = path.join(root, p);
  const st = await fs.lstat(target).catch((e) => { if (e.code !== 'ENOENT') throw e; return null; });
  if (st && !st.isFile()) throw new Error('SOURCE_TYPE');
  return target;
}
let applied = [];
async function main() {
  if (spec.mode === 'scan') return { manifest: await scan() };
  if (spec.mode === 'activate') {
    const current = await fence();
    if (current.epoch > spec.epoch || (current.epoch === spec.epoch && (current.token !== spec.token || current.retired))) throw new Error('WORKSPACE_FENCE_LOST');
    await atomic(fenceFile, JSON.stringify({ epoch: spec.epoch, token: spec.token, base_hash: spec.base_hash, target_hash: spec.target_hash }));
    return { activated: true };
  }
  if (spec.mode === 'retire') {
    const current = await fence();
    if (current.epoch > spec.epoch || (current.epoch === spec.epoch && current.token && current.token !== spec.token)) throw new Error('WORKSPACE_FENCE_LOST');
    await atomic(fenceFile, JSON.stringify({ ...current, epoch: spec.epoch, token: spec.token, retired: true }));
    return { manifest: await scan(), quiesced: true };
  }
  await checkFence();
  if (spec.mode === 'promote' || spec.mode === 'materialize') {
    const before = await scan();
    const target = sourceManifest(spec.files);
    if (target.code_hash !== spec.target_hash) throw new Error('WORKSPACE_TARGET_CONFLICT');
    const authority = await fence();
    if (authority.target_hash && target.code_hash !== authority.target_hash) throw new Error('WORKSPACE_TARGET_CONFLICT');
    if (spec.mode === 'promote') {
      // Only a baseline or already-applied recorded path is recoverable. Third values stop.
      const expected = sourceManifest(spec.baseline);
      if (authority.base_hash && expected.code_hash !== authority.base_hash) throw new Error('WORKSPACE_BASE_CONFLICT');
      const intended = new Map(target.files.map((f) => [f.path, f.hash]));
      const originals = new Map(expected.files.map((f) => [f.path, f.hash]));
      for (const p of new Set([...originals.keys(), ...intended.keys(), ...before.files.map((f) => f.path)])) {
        const actual = before.files.find((f) => f.path === p)?.hash ?? null;
        if (actual !== (originals.get(p) ?? null) && actual !== (intended.get(p) ?? null)) throw new Error(`WORKSPACE_SOURCE_CONFLICT: ${p}`);
      }
    } else if (before.code_hash !== spec.expected_hash) throw new Error('WORKSPACE_SOURCE_CONFLICT');
    const changes = sourceDiff(before, target);
    const operations = applied;
    for (const c of changes) {
      await checkFence();
      const full = await safePath(c.path);
      if (c.operation === 'delete') await fs.unlink(full);
      else {
        const temp = path.join(dir, `source-${spec.operation_id}-${sha256(c.path)}`);
        await fs.writeFile(temp, c.content);
        if (sha256(await fs.readFile(temp)) !== c.after_hash) throw new Error('WORKSPACE_STAGE_CONFLICT');
        await checkFence();
        await fs.rename(temp, full);
      }
      operations.push({ path: c.path, operation: c.operation, status: 'succeeded' });
      // Test-only crash fixture occurs after real atomic replacement, never enabled by Agent.
      if (spec.testFailAfter === operations.length) throw new Error('TEST_PARTIAL');
    }
    const manifest = await scan();
    if (manifest.code_hash !== target.code_hash) throw new Error('WORKSPACE_MANIFEST_CONFLICT');
    return { manifest, operations };
  }
  throw new Error('WORKSPACE_GATEWAY_MODE');
}
try {
  const result = await main();
  console.log('__FORGE_WORKSPACE__' + JSON.stringify(result));
} catch (error) {
  const manifest = await scan().catch(() => null);
  console.log('__FORGE_WORKSPACE__' + JSON.stringify({ error: String(error.message), operations: applied, manifest }));
  process.exitCode = 1;
}

// A completed gateway may remove its own spec; unresolved/killed operations remain for inspection.
await fs.unlink(process.argv[2]).catch(() => {});
