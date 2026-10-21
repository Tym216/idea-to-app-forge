import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DaytonaProvider,sandboxLabels} from '../src/sandbox/daytona.js';
const ref='abcdefghijklmnopqrst',identity={environmentId:'atoms-demo',projectRef:ref},owner={projectId:'p',userId:'u'};
function fixture(result){
 let fallback=0,signs=0;
 const sandbox={id:'s',labels:sandboxLabels(owner,identity),getSignedPreviewUrl:async(port,seconds)=>{
  signs++;assert.equal(port,5173);assert.equal(seconds,86400);if(result instanceof Error)throw result;return result;
 },getPreviewLink:async()=>{fallback++;throw Error('unsigned fallback forbidden');}};
 const provider=new DaytonaProvider({settings:{environmentId:'atoms-demo',expectedSupabaseProjectRef:ref,supabaseUrl:'https://'+ref+'.supabase.co',supabaseServiceRoleKey:'sb_secret_offline',envFileExplicit:true},client:{get:async()=>sandbox}});
 provider.bindOwner('s',owner);provider.cache.set('s',{workdir:'/home/daytona/app'});
 return {provider,counts:()=>({fallback,signs})};
}
test('private iframe signing failure, empty URL or login URL cannot fall back to unsigned preview',async()=>{
 for(const result of [Error('signing failed'),{}, {url:'https://auth.daytona.io/login'},{url:'http://unsigned.test/'}]){
  const f=fixture(result);await assert.rejects(f.provider.previewUrl('s'),{code:'PREVIEW_AUTH_UNAVAILABLE'});
  assert.deepEqual(f.counts(),{fallback:0,signs:1});
 }
});
test('owned signed preview is returned without unsigned fallback',async()=>{
 const f=fixture({url:'https://5173-new.daytonaproxy01.net/'});
 assert.equal(await f.provider.previewUrl('s'),'https://5173-new.daytonaproxy01.net/');assert.deepEqual(f.counts(),{fallback:0,signs:1});
});
