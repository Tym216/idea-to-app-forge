import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceManifest, sourceDiff, applySourceChanges, normalizeSourcePath, buildFingerprint, verifyFingerprint, evidenceValid, checkpointReady } from '../src/managed-source.js';

test('canonical source includes lockfile, ignores runtime, preserves bytes and sorts normalized paths', () => {
  const rows = [{ path: './src//App.tsx', content: 'A\r\n' }, { path: 'package-lock.json', content: '{}' },
    { path: 'node_modules/x.js', content: 'dep' }, { path: '.forge-verify/run.mjs', content: 'runner' }, { path: '.env', content: 'secret' }];
  const a = sourceManifest(rows), b = sourceManifest([...rows].reverse());
  assert.equal(a.code_hash, b.code_hash); assert.deepEqual(a.files.map((f) => f.path), ['package-lock.json', 'src/App.tsx']);
  assert.notEqual(a.code_hash, sourceManifest([{ path: 'src/App.tsx', content: 'A\n' }, rows[1]]).code_hash);
  assert.equal(normalizeSourcePath('./src//App.tsx'), 'src/App.tsx');
});

test('incomplete/binary/symlink/duplicate/traversal manifests fail instead of silently dropping source', () => {
  for (const rows of [[{ path: 'a', content: '\0' }], [{ path: 'a', content: 'x', symlink: true }],
    [{ path: 'a', content: 'x' }, { path: './a', content: 'y' }], [{ path: '../a', content: 'x' }]]) assert.throws(() => sourceManifest(rows));
  assert.throws(() => sourceManifest([{ path: 'a', content: 'xx' }], { files: 1, fileBytes: 1, bytes: 1 }), { code: 'SOURCE_LIMIT' });
});

test('deletion is absent in manifest and explicit in diff; no-op content yields no delta', () => {
  const a = sourceManifest([{ path: 'a.ts', content: 'A' }, { path: 'b.ts', content: 'B' }]);
  const b = applySourceChanges(a, [{ operation: 'delete', path: 'a.ts' }, { operation: 'write', path: 'b.ts', content: 'B' }]);
  assert.deepEqual(sourceDiff(a, b), [{ operation: 'delete', path: 'a.ts', before_hash: a.files[0].hash, after_hash: null }]);
  assert.deepEqual(sourceDiff(a, applySourceChanges(a, [{ operation: 'write', path: 'a.ts', content: 'A' }])), []);
});

test('basis fingerprint ignores provenance, compares config semantically and invalidates meaningful changes', () => {
  const build = { command: 'npm run build', installCommand: 'npm install', nodeVersion: 'v24', npmVersion: '11', platform: 'linux', arch: 'x64', environmentHash: 'H' };
  assert.equal(buildFingerprint(build), buildFingerprint({ ...build, execution_id: 'E2', task_id: 't', retry: 3, time: 'now' }));
  assert.notEqual(buildFingerprint(build), buildFingerprint({ ...build, nodeVersion: 'v25' }));
  const a = [{ id: 'A1', steps: [{ op: 'expectText', selector: 'main', contains: 'ok' }], severity: 'core' }];
  const f = verifyFingerprint(a, { runnerHash: 'R', playwrightVersion: '1' });
  assert.equal(f, verifyFingerprint(a.map((c) => ({ ...c, action: 'changed wording', plan_id: 'new' })), { runnerHash: 'R', playwrightVersion: '1' }));
  assert.notEqual(f, verifyFingerprint([{ ...a[0], severity: 'detail' }], { runnerHash: 'R', playwrightVersion: '1' }));
});

test('same revision/basis evidence survives new execution; stale or unresolved workspace cannot publish', () => {
  const w = { state: 'confirmed', revision: 2, code_hash: 'H', build_fingerprint: 'B', verify_fingerprint: 'V', writer_token: null };
  const b = { workspace_revision: 2, code_hash: 'H', basis_fingerprint: 'B', status: 'passed', execution_id: 'old' };
  const v = { ...b, basis_fingerprint: 'V', status: 'inconclusive' };
  assert.equal(checkpointReady(w, b, v), true);
  assert.equal(evidenceValid(b, { revision: 2, codeHash: 'H', basisFingerprint: 'B', execution_id: 'new' }), true);
  for (const state of ['partial', 'uncertain', 'conflict', 'applying']) assert.equal(checkpointReady({ ...w, state }, b, v), false);
  assert.equal(checkpointReady(w, b, { ...v, status: 'blocker' }), false);
  assert.equal(checkpointReady(w, b, { ...v, status: 'tool_error' }), false);
  assert.equal(checkpointReady({ ...w, revision: 3 }, b, v), false);
});
