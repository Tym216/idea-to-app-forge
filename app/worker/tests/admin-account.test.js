import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateDemoAccount } from '../src/admin-account.js';
const id = '11111111-1111-1111-1111-111111111111';
const args = { id, currentEmail: 'old@example.com', email: 'demo@example.com', password: 'test-only-password' };
function fake() {
  const writes = [];
  return { writes, auth: { admin: {
    getUserById: async (uid) => ({ data: { user: { id: uid, email: args.currentEmail } } }),
    updateUserById: async (uid, fields) => { writes.push({ uid, fields }); return { data: { user: { id: uid } } }; },
  } } };
}
test('account update preserves original UID and changes only email/password/confirmation', async () => {
  const client = fake();
  assert.equal(await updateDemoAccount(client, args), id);
  assert.deepEqual(client.writes, [{ uid: id, fields: { email: args.email, password: args.password, email_confirm: true } }]);
});
test('wrong original email cannot change another account', async () => {
  const client = fake();
  await assert.rejects(updateDemoAccount(client, { ...args, currentEmail: 'wrong@example.com' }), /原邮箱不匹配/);
  assert.equal(client.writes.length, 0);
});
test('invalid UID or password is rejected before admin writes', async () => {
  const client = fake();
  await assert.rejects(updateDemoAccount(client, { ...args, id: 'x' }), /ID/);
  await assert.rejects(updateDemoAccount(client, { ...args, password: 'short' }), /密码/);
  assert.equal(client.writes.length, 0);
});
test('failed update is not automatically retried', async () => {
  const client = fake(); let count = 0;
  client.auth.admin.updateUserById = async () => { count++; return { error: { message: 'network timeout' } }; };
  await assert.rejects(updateDemoAccount(client, args), /更新失败/);
  assert.equal(count, 1);
});
