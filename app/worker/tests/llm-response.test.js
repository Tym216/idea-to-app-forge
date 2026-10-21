import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { chat, responseDiagnostics } from '../src/llm.js';
import { __setTelemetryForTest } from '../src/telemetry.js';

test('响应诊断区分截断、拒绝、工具调用和上游错误,不包含原始内容', () => {
  const data = responseDiagnostics({ choices: [{ finish_reason: 'length', message: { content: null, reasoning: 'PRIVATE_REASONING', refusal: 'PRIVATE_REFUSAL', tool_calls: [{}] } }], error: { message: 'PRIVATE_ERROR' } });
  assert.equal(data.finish_reason, 'length');
  assert.equal(data.content_type, 'null');
  assert.equal(data.has_reasoning, true);
  assert.equal(data.has_refusal, true);
  assert.equal(data.tool_calls_count, 1);
  assert.equal(data.has_upstream_error, true);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE/);
  assert.equal(responseDiagnostics({}).choices_count, 0);
  assert.equal(responseDiagnostics({}).content_type, 'undefined');
});

test('空正文仍拒绝且不重试,但 Langfuse 保留 finish_reason 和真实用量', async () => {
  const previous = { ...config };
  const oldFetch = globalThis.fetch;
  const updates = [];
  let calls = 0;
  __setTelemetryForTest({ tracing: { startActiveObservation: async (_name, fn) => fn({ update: (attrs) => updates.push(attrs) }) } });
  try {
    Object.assign(config, { llmProvider: 'openrouter', openrouterApiKey: 'test-key', openrouterModel: 'test-model' });
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '', reasoning: 'PRIVATE_REASONING' } }], usage: { prompt_tokens: 9, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 30 } } }) };
    };
    await assert.rejects(() => chat([]), (error) => error.code === 'LLM_INVALID_RESPONSE' && /finish_reason=length/.test(error.message));
    assert.equal(calls, 1);
    const diagnostic = updates.find((attrs) => attrs.metadata?.status === 'invalid_response');
    assert.deepEqual(diagnostic.usageDetails, { input: 9, output: 30 });
    assert.equal(diagnostic.metadata.usage_breakdown.reasoning_tokens, 30);
    assert.equal(diagnostic.metadata.has_reasoning, true);
    assert.equal(diagnostic.metadata.finish_reason, 'length');
    assert.doesNotMatch(JSON.stringify(updates), /PRIVATE_REASONING/);
  } finally {
    Object.assign(config, previous);
    globalThis.fetch = oldFetch;
    __setTelemetryForTest();
  }
});


test('repair caller can only shorten provider deadline; timeout aborts real request signal with no blind retry', async () => {
  const prior={...config},oldFetch=globalThis.fetch;
  try {
    Object.assign(config,{llmProvider:'openrouter',openrouterApiKey:'offline',openrouterModel:'offline',llmTimeoutMs:30});
    for(const timeoutMs of [10,1000]){
      let requests=0;
      globalThis.fetch=async(_url,{signal})=>{
        requests++;
        return new Promise((resolve,reject)=>{
          const hold=setTimeout(()=>resolve(new Response('{}')),1000);
          signal.addEventListener('abort',()=>{clearTimeout(hold);reject(signal.reason);},{once:true});
        });
      };
      await assert.rejects(()=>chat([],{timeoutMs}),{code:'LLM_TIMEOUT'});
      assert.equal(requests,1);
    }
  }finally{Object.assign(config,prior);globalThis.fetch=oldFetch;}
});
