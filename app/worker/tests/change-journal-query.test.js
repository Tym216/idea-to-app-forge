import {config} from '../src/config.js';
Object.assign(config,{environmentId:'atoms-demo',expectedSupabaseProjectRef:'abcdefghijklmnopqrst',envFileExplicit:true,supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',supabaseServiceRoleKey:'offline-key'});
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-placeholder';
const { listChangeJournals } = await import('../src/supabase.js');

test('real SDK emits valid JSONB containment and preserves project filter, ordering and pagination', async () => {
  const original = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url) => {
      const params = new URL(String(url)).searchParams;
      requests.push(params);
      assert.equal(params.get('project_id'), 'eq.project-id');
      assert.equal(params.get('steps'), 'cs.[{"tool":"change_journal"}]');
      assert.deepEqual(JSON.parse(params.get('steps').slice(3)), [{ tool: 'change_journal' }]);
      assert.equal(params.get('order'), 'created_at.asc,id.asc');
      assert.equal(params.get('limit'), '100');
      const offset = Number(params.get('offset'));
      const count = offset === 0 ? 100 : 1;
      return new Response(JSON.stringify(Array.from({ length: count }, (_, n) => ({
        id: String(offset + n), steps: [{ tool: 'change_journal' }],
      }))), { headers: { 'Content-Type': 'application/json' } });
    };
    const rows = await listChangeJournals('project-id');
    assert.equal(rows.length, 101);
    assert.deepEqual(requests.map((params) => params.get('offset')), ['0', '100']);
    assert.equal(rows[100].id, '100');
  } finally { globalThis.fetch = original; }
});

test('journal query errors stop reconciliation rather than pretending there are no pending changes', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: '22P02', message: 'invalid input syntax for type json' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
    await assert.rejects(listChangeJournals('project-id'), (error) =>
      error.code === 'SUPABASE_STATE' && /修改记录读取.*invalid input syntax/.test(error.message));
  } finally { globalThis.fetch = original; }
});
