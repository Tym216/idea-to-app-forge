import {previewLoadGuard} from '../../shared/preview-load-guard.js';

import test from 'node:test';import assert from 'node:assert/strict';
import {createPreviewPlugin,platformDevCommand,previewHostOrigin,renderPreviewConfig,PREVIEW_RUNTIME_FINGERPRINT} from '../src/preview-platform.js';
import {previewBootstrap,appStorageKey,attachPreviewStorage} from '../../shared/preview-storage.js';
test('platform preview wraps supported Vite command without modifying managed source',()=>{
 assert.equal(platformDevCommand('npm run --ignore-scripts dev'),'npm run --ignore-scripts dev -- --config .forge-preview/vite.config.mjs');
 assert.match(platformDevCommand('npm run --ignore-scripts dev -- --port 5173'),/--port 5173 --config/);
 assert.throws(()=>platformDevCommand('arbitrary command'),/UNSUPPORTED/);
 assert.equal(previewHostOrigin({environmentId:'atoms-demo'}),'https://idea-to-app-forge.onrender.com');
 assert.throws(()=>previewHostOrigin({environmentId:'production-main'}),/REQUIRED/);
 assert.throws(()=>previewHostOrigin({forgePublicOrigin:'https://forge.test/path'}),/INVALID/);
 assert.match(renderPreviewConfig({environmentId:'atoms-demo'},{projectId:'p'}),/loadConfigFromFile/);
});
test('runtime defers all modules and rejects classic execution before storage hydration',()=>{
 assert.throws(()=>createPreviewPlugin({},previewBootstrap.toString()),/LOAD_GUARD_REQUIRED/);
 const plugin=createPreviewPlugin({hostOrigin:'https://forge.test',projectId:'p'},previewBootstrap.toString(),previewLoadGuard.toString());
 const html=plugin.transformIndexHtml.handler('<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>');
 assert.match(html,/application\/forge-deferred-module/);assert.match(html,/await boot/);assert.match(html,/PREVIEW_LOAD_TIMEOUT/);
 assert.throws(()=>plugin.transformIndexHtml.handler('<head></head><script>unsafe()</script>'),/UNSUPPORTED/);
 assert.throws(()=>plugin.transformIndexHtml.handler('<head></head><script type="module">const x="</script><script>bad</script>";</script>'),/UNSUPPORTED/);
});
test('platform namespace ignores code/runtime identity and separates owner/projects',()=>{
 const id={environment:'demo',ref:'ref',userId:'u',projectId:'p'};
 assert.equal(appStorageKey(id),appStorageKey({...id,version:8,sandbox:'changed'}));
 assert.notEqual(appStorageKey(id),appStorageKey({...id,userId:'other'}));
 assert.notEqual(appStorageKey(id),appStorageKey({...id,projectId:'other'}));
});
test('bridge rejects untrusted window/origin before any storage access',async()=>{
 let listener,writes=0,reads=0;
 const frame={contentWindow:{postMessage(){throw Error('must not respond');}}};
 const dispose=attachPreviewStorage({frame,origin:'https://app.test',identity:{environment:'d',ref:'r',userId:'u',projectId:'p'},
  storage:{getItem(){reads++;},setItem(){writes++;}},host:{addEventListener(_,fn){listener=fn;},removeEventListener(){}},locks:{request(){throw Error('must not lock');}}});
 for(const event of [{source:{},origin:'https://app.test'},{source:frame.contentWindow,origin:'https://foreign.test'}])
  await listener({...event,data:{protocol:'forge-preview-storage-v1',op:'hello',channel:'1234567890123456',legacy:{}}});
 assert.equal(writes,0);assert.equal(reads,0);dispose();
});

import {DaytonaProvider,sandboxLabels} from '../src/sandbox/daytona.js';
const ref='abcdefghijklmnopqrst';
const settings={environmentId:'atoms-demo',expectedSupabaseProjectRef:ref,supabaseUrl:'https://'+ref+'.supabase.co',envFileExplicit:true,supabaseServiceRoleKey:'offline'};
function runtimeFixture(mode){
 const calls=[];let state='started',stopped=false;
 const sb={id:'owned',labels:sandboxLabels({projectId:'p',userId:'u'},{environmentId:'atoms-demo',projectRef:ref})};
 const p=new DaytonaProvider({settings,client:{
 get:async()=>({...sb,state}),stop:async()=>{calls.push('stop');state=mode==='error'?'error':'stopped';stopped=true;},
 start:async()=>{assert.equal(stopped,true);calls.push('start');state='started';}
 }});
 p.bindOwner(sb.id,{projectId:'p',userId:'u'});
 p.isPortListening=async()=>true;
 p.exec=async()=>mode==='current'?{exitCode:0,stdout:JSON.stringify({version:'forge-preview-storage-v1',fingerprint:PREVIEW_RUNTIME_FINGERPRINT})}:{exitCode:0,stdout:'legacy HTML'};
 return {p,calls};
}
test('healthy platform runtime is reused without lifecycle changes',async()=>{
 const {p,calls}=runtimeFixture('current');await p.ensurePreviewPlatform('owned');assert.deepEqual(calls,[]);
});
test('legacy platform upgrade confirms stopped before start; uncertain lifecycle never starts',async()=>{
 const {p,calls}=runtimeFixture('legacy');await p.ensurePreviewPlatform('owned');assert.deepEqual(calls,['stop','start']);
 const bad=runtimeFixture('error');await assert.rejects(bad.p.ensurePreviewPlatform('owned'),/WORKSPACE_UNCERTAIN/);assert.deepEqual(bad.calls,['stop']);
});
