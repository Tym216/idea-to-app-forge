import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderPersistenceHelper} from '../src/app-persistence.js';
const store=new Map();const storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};
async function app(project='p'){return import('data:text/javascript;base64,'+Buffer.from(renderPersistenceHelper('atoms-demo',project)).toString('base64'));}
test('reload and compatible code version retain namespace; different projects isolate state; transient state has no automatic persistence',async()=>{
 const {createAppState}=await app();const a=createAppState('todos',{initialValue:[],storage});a.write(['one']);
 const b=(await app()).createAppState('todos',{initialValue:[],storage});assert.equal(a.key,b.key);assert.deepEqual(b.read().value,['one']);
 assert.equal((await app('other')).createAppState('todos',{initialValue:[],storage}).read().status,'empty');
 const size=store.size;createAppState('unused',{initialValue:[],storage});assert.equal(store.size,size);
});
test('malformed / unknown schema / migration failure retain original bytes and block writes; compatible migration is explicit',async()=>{
 const {createAppState}=await app();const a=createAppState('notes',{initialValue:[],storage});
 for(const raw of ['{bad',JSON.stringify({schemaVersion:9,value:['old']})]){
  store.set(a.key,raw);assert.equal(a.read().status,'blocked');assert.throws(()=>a.write([]),/retained/);assert.equal(store.get(a.key),raw);
 }
 store.set(a.key,JSON.stringify({schemaVersion:1,value:['old']}));
 const bad=createAppState('notes',{initialValue:[],schemaVersion:2,migrate:()=>{throw Error('bad');},storage});
 assert.equal(bad.read().status,'blocked');assert.throws(()=>bad.write([]));assert.equal(JSON.parse(store.get(a.key)).schemaVersion,1);
 const next=createAppState('notes',{schemaVersion:2,initialValue:[],migrate:v=>v.map(text=>({text})),storage});
 assert.deepEqual(next.read().value,[{text:'old'}]);next.write(next.read().value);assert.equal(JSON.parse(store.get(a.key)).schemaVersion,2);
});

test('unserializable state cannot replace a valid record; logical collection must be a string',async()=>{
 const {createAppState}=await app();const state=createAppState('settings',{initialValue:{},storage});state.write({dark:true});
 const original=store.get(state.key);
 assert.throws(()=>state.write(undefined),/retained/);assert.equal(store.get(state.key),original);
 assert.throws(()=>createAppState({}, {storage}),/configuration/);
});

test('complete game snapshot survives re-entry/auth logout; explicit scoped reset leaves other data intact',async()=>{
 const {createAppState}=await app('game');
 const state=createAppState('game-session',{initialValue:{score:0,snake:[[1,1]],direction:'right'},storage});
 const session={score:70,snake:[[8,2],[7,2],[6,2]],food:[4,4],direction:'up',level:2,paused:true};
 state.write(session);store.set('auth-session','token');
 store.delete('auth-session'); // Forge logout removes its own session only.
 const reentered=createAppState('game-session',{initialValue:{score:0},storage});
 assert.deepEqual(reentered.read().value,session);
 const originalOther=createAppState('notes',{initialValue:[],storage});originalOther.write(['keep']);
 state.reset();assert.equal(state.read().value.score,0);
 assert.deepEqual(originalOther.read().value,['keep']);
 store.set(state.key,'{bad');assert.equal(state.read().status,'blocked');
 assert.equal(store.get(state.key),'{bad');state.reset();assert.equal(state.read().status,'restored');
});
