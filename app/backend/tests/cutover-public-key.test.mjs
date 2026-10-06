import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicKeySanityCheck } from './cutover-public-key.mjs';
test('public-key sanity uses apikey-only public endpoints, not admin OpenAPI or a user session',async()=>{
  const seen=[];
  const r=await publicKeySanityCheck('https://disposable.invalid','test-public',async(url,options)=>{
    seen.push(url);assert.equal(options.method,'GET');assert.deepEqual(options.headers,{apikey:'test-public',Accept:'application/json'});
    if(url.endsWith('/auth/v1/settings'))return {ok:true,json:async()=>({external:{}})};
    return {status:404,json:async()=>({code:'PGRST205'})};
  });
  assert.equal(seen.length,2);assert.ok(!seen.some(u=>u.endsWith('/rest/v1/')));assert.equal(r.authorization_header_sent,false);
});
test('public-key sanity does not misclassify 401 or arbitrary 404 as a successful Data API probe',async()=>{
  for(const status of [401,404])await assert.rejects(publicKeySanityCheck('https://disposable.invalid','test-public',async(url)=>url.endsWith('/auth/v1/settings')?{ok:true,json:async()=>({external:{}})}:{status,json:async()=>({code:'NOT_PGRST205'})}),{code:'PUBLIC_DATA_HTTP_'+status});
});
