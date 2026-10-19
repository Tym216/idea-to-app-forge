import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {previewBootstrap} from '../../shared/preview-storage.js';
function fallbackBrowser(){
 const expected='https://forge.test',channel='random-channel-123456789',messages=[],timers=[],listeners={};
 const parent={postMessage:(data,origin)=>messages.push({data,origin})};
 const win={parent,addEventListener:(type,fn)=>listeners[type]=fn};
 const context=vm.createContext({window:win,location:{hostname:'preview.test'},document:{referrer:'https://proxy-hop.test/path',
  createElement:()=>({style:{},setAttribute(){}}),body:{append(){}}},URL,crypto:{randomUUID:()=>channel},
  localStorage:{},Storage:class Storage{},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},setInterval:()=>1,clearInterval(){}});
 const pending=vm.runInContext('('+previewBootstrap.toString()+')({hostOrigin:"https://forge.test",projectId:"p"},[])',context);
 const deliver=(origin,source=parent,fields={})=>listeners.message({origin,source,data:{protocol:'forge-preview-storage-v1',channel,op:'ready',session:'session-id',revision:0,entries:{},...fields}});
 return {win,parent,pending,deliver,timers,messages,expected};
}
test('without ancestorOrigins, proxy referrer grants no authority; only exact parent/origin/channel handshake launches',async()=>{
 const b=fallbackBrowser();let completed=false;b.pending.then(()=>{completed=true;});
 assert.equal(b.messages[0].origin,b.expected);assert.notEqual(b.messages[0].origin,'*');
 b.deliver('https://foreign.test');b.deliver(b.expected,{});b.deliver(b.expected,b.parent,{channel:'wrong-channel'});
 await Promise.resolve();assert.equal(completed,false);assert.equal(b.win.__forgePreviewPhase,'hydrating');
 assert.equal(Object.getOwnPropertyDescriptor(b.win,'localStorage'),undefined);
 b.deliver(b.expected);await b.pending;assert.equal(b.win.__forgePreviewPhase,'app-loaded');assert.equal(b.win.__forgeStorageStatus.status,'ready');
});
test('unsupported ancestor API never turns missing parent authentication into fail-open launch',async()=>{
 const b=fallbackBrowser();b.deliver('https://foreign.test');
 const rejected=assert.rejects(b.pending,/APP_STORAGE_TIMEOUT/);b.timers[0]();await rejected;
 assert.equal(b.win.__forgePreviewPhase,'hydrating');assert.equal(Object.getOwnPropertyDescriptor(b.win,'localStorage'),undefined);
});
