import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateFrontendConfig} from '../config/environment.js';
const ref='abcdefghijklmnopqrst';
const values={VITE_FORGE_ENVIRONMENT_ID:'atoms-demo',VITE_EXPECTED_SUPABASE_PROJECT_REF:ref,VITE_SUPABASE_URL:'https://'+ref+'.supabase.co',VITE_SUPABASE_ANON_KEY:'sb_publishable_offline'};
test('Demo build refuses default Main .env fallback even for an opaque API key; explicit complete mode config or process values allowed',()=>{
 const root=mkdtempSync(join(tmpdir(),'forge-front-env-'));
 try{
  writeFileSync(join(root,'.env'),'VITE_SUPABASE_ANON_KEY=sb_publishable_main');
  assert.throws(()=>validateFrontendConfig(values,{root,mode:'atoms-demo',processEnv:{...values,VITE_SUPABASE_ANON_KEY:undefined}}),/fallback forbidden/);
  assert.doesNotThrow(()=>validateFrontendConfig(values,{root,mode:'production',processEnv:values}));
  writeFileSync(join(root,'.env.atoms-demo'),Object.entries(values).map(([k,v])=>k+'='+v).join('\n'));
  assert.doesNotThrow(()=>validateFrontendConfig(values,{root,mode:'atoms-demo',processEnv:{}}));
  for(const bad of [{VITE_FORGE_ENVIRONMENT_ID:''},{VITE_EXPECTED_SUPABASE_PROJECT_REF:''},{VITE_SUPABASE_URL:'https://vfzyimhapttcdxeabvur.supabase.co'},{VITE_SUPABASE_ANON_KEY:'placeholder'}])
   assert.throws(()=>validateFrontendConfig({...values,...bad},{root,mode:'atoms-demo',processEnv:values}));
 }finally{rmSync(root,{recursive:true});}
});
