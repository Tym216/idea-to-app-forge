import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvLines } from '../src/env.js';

test('multi-line provider options are parsed as one JSON value without swallowing later keys', () => {
  const source = [
    'PLAN_PROVIDER_OPTIONS={',
    '  "thinking": {',
    '    "type": "enabled"',
    '  }',
    '}',
    'BUILD_PROVIDER_OPTIONS={',
    '  "thinking": { "type": "disabled" }',
    '}',
    'NEXT_SECRET=do-not-echo',
  ].join('\n');
  const pairs = Object.fromEntries(parseEnvLines(source));
  assert.deepEqual(JSON.parse(pairs.PLAN_PROVIDER_OPTIONS), { thinking: { type: 'enabled' } });
  assert.deepEqual(JSON.parse(pairs.BUILD_PROVIDER_OPTIONS), { thinking: { type: 'disabled' } });
  assert.equal(pairs.NEXT_SECRET, 'do-not-echo');
});

test('incomplete options remain invalid and next assignment is not consumed', () => {
  const pairs = Object.fromEntries(parseEnvLines('PLAN_PROVIDER_OPTIONS={\nNEXT_SECRET=kept'));
  assert.equal(pairs.PLAN_PROVIDER_OPTIONS, '{');
  assert.equal(pairs.NEXT_SECRET, 'kept');
});
