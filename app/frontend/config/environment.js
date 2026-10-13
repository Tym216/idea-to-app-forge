import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {assertEnvironment,assertKeyProject} from '../../shared/environment.js';
const required=['VITE_FORGE_ENVIRONMENT_ID','VITE_EXPECTED_SUPABASE_PROJECT_REF','VITE_SUPABASE_URL','VITE_SUPABASE_ANON_KEY'];
/** Provenance check: Vite's default .env must not silently fill incomplete Demo config. */
export function validateFrontendConfig(env,{root,mode,processEnv=process.env}) {
 const explicit=new Set(required.filter(key=>processEnv[key]!==undefined));
 for(const name of ['.env.'+mode,'.env.'+mode+'.local']) {
  const file=join(root,name);
  if(existsSync(file)) for(const line of readFileSync(file,'utf8').split(/\r?\n/)) {
   const match=/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
   if(match)explicit.add(match[1]);
  }
 }
 assertEnvironment({environmentId:env.VITE_FORGE_ENVIRONMENT_ID,expectedRef:env.VITE_EXPECTED_SUPABASE_PROJECT_REF,
  supabaseUrl:env.VITE_SUPABASE_URL,explicit:required.every(key=>explicit.has(key))});
 assertKeyProject(env.VITE_SUPABASE_ANON_KEY,env.VITE_EXPECTED_SUPABASE_PROJECT_REF);
}
