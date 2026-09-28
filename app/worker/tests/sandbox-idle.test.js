import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DAYTONA_AUTO_STOP_MINUTES = '120';
const { DaytonaProvider } = await import('../src/sandbox/daytona.js');
test('existing sandbox is updated to 120 minutes using installed SDK method', async () => {
  const calls = [];
  const sb = { autoStopInterval: 60, setAutostopInterval: async (n) => calls.push(n) };
  await DaytonaProvider.prototype.configureIdle.call({}, sb);
  assert.deepEqual(calls, [120]);
});
test('120-minute sandbox needs no repeated configuration call', async () => {
  await DaytonaProvider.prototype.configureIdle.call({}, { autoStopInterval: 120, setAutostopInterval: async () => { throw new Error('unexpected'); } });
});
