import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertEnvironment,assertKeyProject,MAIN_REF,RESTORE_REF} from '../../shared/environment.js';
import {DaytonaProvider,sandboxLabels} from '../src/sandbox/daytona.js';
const ref='abcdefghijklmnopqrst';
const valid={environmentId:'atoms-demo',expectedRef:ref,supabaseUrl:'https://'+ref+'.supabase.co',explicit:true};
const settings={...valid,expectedSupabaseProjectRef:ref,envFileExplicit:true,supabaseServiceRoleKey:'offline-key',daytonaAutoStopMinutes:120};
test('missing profile/target, Main, restore, URL/ref mismatch and fallback fail closed; explicit future production Main allowed',()=>{
 for(const change of [{environmentId:''},{expectedRef:''},{expectedRef:MAIN_REF,supabaseUrl:'https://'+MAIN_REF+'.supabase.co'},{expectedRef:RESTORE_REF,supabaseUrl:'https://'+RESTORE_REF+'.supabase.co'},{supabaseUrl:'https://'+MAIN_REF+'.supabase.co'},{explicit:false}])
  assert.throws(()=>assertEnvironment({...valid,...change}),/ENVIRONMENT_ISOLATION/);
 assert.doesNotThrow(()=>assertEnvironment({environmentId:'production-main',expectedRef:MAIN_REF,supabaseUrl:'https://'+MAIN_REF+'.supabase.co'}));
 const wrong='eyJ'+'.'+Buffer.from(JSON.stringify({ref:MAIN_REF})).toString('base64url')+'.x';
 assert.throws(()=>assertKeyProject(wrong,ref),/project mismatch/);
});
test('Demo loader rejects incomplete explicit env instead of ambient Main fallback',()=>{
 const dir=mkdtempSync(join(tmpdir(),'forge-env-'));const file=join(dir,'demo.env');
 writeFileSync(file,'FORGE_ENVIRONMENT_ID=atoms-demo\nEXPECTED_SUPABASE_PROJECT_REF='+ref+'\n');
 try {
  const child=spawnSync(process.execPath,['-e',"import('./src/env.js')"],{cwd:new URL('..',import.meta.url),env:{...process.env,FORGE_ENVIRONMENT_ID:'atoms-demo',FORGE_ENV_FILE:file,SUPABASE_URL:'https://'+MAIN_REF+'.supabase.co'},encoding:'utf8'});
  assert.notEqual(child.status,0);assert.match(child.stderr,/no fallback/);
 }finally{rmSync(dir,{recursive:true});}
});
test('all Daytona exits reject foreign/unlabelled sandbox before any side effect, including raw-client preview/delete and cache hits',async()=>{
 for(const labels of [{},sandboxLabels({projectId:'p',userId:'u'},{environmentId:'production-main',projectRef:MAIN_REF}),sandboxLabels({projectId:'other',userId:'u'},{environmentId:'atoms-demo',projectRef:ref})]) {
  let effects=0;const side=async()=>{effects++;return{result:'/home/test',exitCode:0};};
  const sb={id:'s',labels,state:'stopped',process:{executeCommand:side,createSession:side},fs:{uploadFile:side,downloadFile:side},getPreviewLink:side,setAutostopInterval:side};
  const p=new DaytonaProvider({settings,client:{get:async()=>sb,start:side,delete:side}});
  p.bindOwner('s',{projectId:'p',userId:'u'});
  p.cache.set('s',{sandbox:sb,workdir:'/home/test/app'});
  for(const f of [()=>p.ensure('s'),()=>p.resolve('s'),()=>p.exec('s','touch x'),()=>p.writeFile('s','src/a.ts','x'),()=>p.readFile('s','src/a.ts'),()=>p.startBackground('s','vite'),()=>p.previewUrl('s'),()=>p.destroy('s'),()=>p.client.start(sb),()=>p.client.delete(sb),()=>p.configureIdle(sb)])
   await assert.rejects(f,/SANDBOX_OWNERSHIP/);
  assert.equal(effects,0);
 }
});

test('only metadata GET transient errors get one bounded retry; no repeated start/upload',async()=>{
 let reads=0,starts=0;
 const sb={id:'s',labels:sandboxLabels({projectId:'p',userId:'u'},{environmentId:'atoms-demo',projectRef:ref}),state:'started'};
 const p=new DaytonaProvider({settings,client:{get:async()=>{if(++reads===1)throw Object.assign(Error('unavailable'),{statusCode:503});return sb;},start:async()=>starts++}});
 p.bindOwner('s',{projectId:'p',userId:'u'});
 assert.equal((await p.client.get('s')).id,'s');assert.equal(reads,2);assert.equal(starts,0);
});

test('explicit Main env cannot be repurposed as Demo through process overrides',()=>{
 const dir=mkdtempSync(join(tmpdir(),'forge-env-main-'));const file=join(dir,'main.env');
 writeFileSync(file,'FORGE_ENVIRONMENT_ID=production-main\nEXPECTED_SUPABASE_PROJECT_REF='+MAIN_REF+'\nSUPABASE_URL=https://'+MAIN_REF+'.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_offline');
 try {
  const child=spawnSync(process.execPath,['-e',"import('./src/env.js')"],{cwd:new URL('..',import.meta.url),env:{...process.env,FORGE_ENVIRONMENT_ID:'atoms-demo',FORGE_ENV_FILE:file,EXPECTED_SUPABASE_PROJECT_REF:ref,SUPABASE_URL:valid.supabaseUrl,SUPABASE_SERVICE_ROLE_KEY:'offline'},encoding:'utf8'});
  assert.notEqual(child.status,0);assert.match(child.stderr,/source profile mismatch/);
 }finally{rmSync(dir,{recursive:true});}
});

test('sandbox creation writes environment/ref/project/user labels; missing owner rejects before creation',async()=>{
 let labels,creates=0;
 const sb={id:'fake-label-test-sandbox',state:'started',process:{executeCommand:async()=>({result:'/home/test'})}};
 const p=new DaytonaProvider({settings,client:{create:async params=>{creates++;labels=params.labels;return {...sb,labels};},get:async()=>({...sb,labels})}});
 await assert.rejects(p.create(),/explicit project\/user/);assert.equal(creates,0);
 await p.create({projectId:'p',userId:'u'});
 assert.equal(labels.environment_id,'atoms-demo');assert.equal(labels.supabase_project_ref,ref);
 assert.equal(labels.forge_project_id,'p');assert.equal(labels.user_id,'u');assert.equal(creates,1);
});

function ownerFixture(owner={projectId:'projectB',userId:'userB'}) {
 const counters={effects:0,gets:0,lists:0};
 const effect=async()=>{counters.effects++;return {result:'/home/test',exitCode:0};};
 const sb={id:'same-demo',state:'started',autoStopInterval:60,
  labels:sandboxLabels(owner,{environmentId:'atoms-demo',projectRef:ref}),
  process:{executeCommand:effect,deleteSession:effect,createSession:effect,executeSessionCommand:effect,getSessionCommandLogs:effect},
  fs:{uploadFile:effect,downloadFile:async()=>{counters.effects++;return Buffer.from('source');}},
  getSignedPreviewUrl:async()=>{counters.effects++;return {url:'https://offline.test/preview'};},
  getPreviewLink:effect,setAutostopInterval:effect,
 };
 const p=new DaytonaProvider({settings,client:{
  get:async()=>{counters.gets++;return sb;},start:effect,stop:effect,delete:effect,
  list:async function*(){counters.lists++;yield sb;},
 }});
 // A metadata/cache entry is never ownership authority.
 p.cache.set(sb.id,{sandbox:sb,workdir:'/home/test/app'});
 return {p,sb,counters};
}
function projectExits(p,sb) {
 return [
  ['ensure',()=>p.ensure(sb.id)],['resolve',()=>p.resolve(sb.id)],
  ['getOwned',()=>p.getOwned(sb.id)],['guarded get',()=>p.client.get(sb.id)],
  ['exec',()=>p.exec(sb.id,'touch x')],['write',()=>p.writeFile(sb.id,'src/a.ts','source')],
  ['read',()=>p.readFile(sb.id,'src/a.ts')],['background',()=>p.startBackground(sb.id,'vite')],
  ['preview',()=>p.previewUrl(sb.id)],['idle',()=>p.configureIdle(sb)],
  ['destroy',()=>p.destroy(sb.id)],['guarded start',()=>p.client.start(sb)],
  ['guarded stop',()=>p.client.stop(sb)],['guarded delete',()=>p.client.delete(sb)],['list files',()=>p.listFiles(sb.id)],
  ['process check',()=>p.checkProcess(sb.id,'vite')],['port check',()=>p.isPortListening(sb.id,5173)],
  ['logs',()=>p.readLogs(sb.id,{commandId:'cmd'})],['empty logs',()=>p.readLogs(sb.id)],
 ];
}
test('same environment/ref but no trusted owner: every project exit fails closed before metadata or side effects',async()=>{
 const {p,sb,counters}=ownerFixture();
 for(const [name,exit] of projectExits(p,sb)) await assert.rejects(exit,{code:'SANDBOX_OWNERSHIP'},name);
 assert.equal(counters.gets,0);assert.equal(counters.effects,0);
 for(const incomplete of [{},{projectId:'projectA'},{userId:'userA'},{projectId:'',userId:'userA'}])
  assert.throws(()=>p.bindOwner(sb.id,incomplete),{code:'SANDBOX_OWNERSHIP'});
});
test('trusted A owner rejects B labels; both expected project and expected user must match',async()=>{
 for(const owner of [{projectId:'projectB',userId:'userB'},{projectId:'projectA',userId:'userB'},{projectId:'projectB',userId:'userA'}]) {
  const {p,sb,counters}=ownerFixture(owner);p.bindOwner(sb.id,{projectId:'projectA',userId:'userA'});
  for(const [name,exit] of projectExits(p,sb)) await assert.rejects(exit,{code:'SANDBOX_OWNERSHIP'},name);
  assert.equal(counters.effects,0);
 }
});
test('trusted owner A + labels A permits project access; conflicting/incomplete rebinding cannot erase authority',async()=>{
 const owner={projectId:'projectA',userId:'userA'}, {p,sb,counters}=ownerFixture(owner);
 p.bindOwner(sb.id,owner);
 for(const [name,exit] of projectExits(p,sb)) await assert.doesNotReject(exit,name);
 assert.ok(counters.effects>0);
 assert.throws(()=>p.bindOwner(sb.id,{projectId:'projectB',userId:'userB'}),{code:'SANDBOX_OWNERSHIP'});
 assert.throws(()=>p.bindOwner(sb.id,{projectId:'projectA'}),{code:'SANDBOX_OWNERSHIP'});
 assert.equal((await p.client.get(sb.id)).id,sb.id);
});
test('environment metadata list is read-only: listing B does not self-authorize any project-specific exit',async()=>{
 const {p,sb,counters}=ownerFixture();
 const listed=await p.list();assert.equal(listed[0].id,sb.id);
 assert.equal(counters.lists,1);assert.equal(counters.gets,0);assert.equal(counters.effects,0);
 for(const [name,exit] of projectExits(p,sb)) await assert.rejects(exit,{code:'SANDBOX_OWNERSHIP'},name);
 assert.equal(counters.gets,0);assert.equal(counters.effects,0);
 p.bindOwner(sb.id,{projectId:'projectA',userId:'userA'});
 await assert.rejects(p.exec(sb.id,'touch x'),{code:'SANDBOX_OWNERSHIP'});
 assert.equal(counters.effects,0);
});
test('idle changes use the freshly verified SDK object, never a supplied object with the same ID',async()=>{
 const {p,sb,counters}=ownerFixture({projectId:'projectA',userId:'userA'});
 p.bindOwner(sb.id,{projectId:'projectA',userId:'userA'});
 await p.configureIdle({id:sb.id,autoStopInterval:60,setAutostopInterval:()=>{throw Error('unverified object');}});
 assert.equal(counters.effects,1);
});

test('bound expected owner survives 404 recreation without requiring labels as a fallback authority',async()=>{
 const owner={projectId:'projectA',userId:'userA'};let creates=0;
 const sb={id:'new',state:'started',labels:sandboxLabels(owner,{environmentId:'atoms-demo',projectRef:ref}),
  process:{executeCommand:async()=>({result:'/home/test'})}};
 const p=new DaytonaProvider({settings,client:{
  get:async id=>{if(id==='missing')throw Object.assign(Error('missing sandbox'),{statusCode:404});return sb;},
  create:async params=>{creates++;assert.equal(params.labels.forge_project_id,owner.projectId);assert.equal(params.labels.user_id,owner.userId);return sb;},
 }});
 p.bindOwner('missing',owner);
 assert.deepEqual(await p.ensure('missing'),{sandboxId:'new',alive:false});assert.equal(creates,1);
});
