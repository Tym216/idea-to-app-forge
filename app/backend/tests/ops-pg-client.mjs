/** Native PG tools with fixed environment identity and verified TLS. No implicit DB/env fallback. */
import {spawn} from 'node:child_process';
import {writeFileSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {operationalConfig,operationalRoot} from './ops-db-target.mjs';

export function nativeEnvironment(config, inherited=process.env) {
  const u=new URL(config.databaseUrl);
  if(u.port && u.port!=='5432')throw Object.assign(new Error(),{code:'SESSION_CONNECTION_REQUIRED'});
  const env=Object.fromEntries(Object.entries(inherited).filter(([k])=>!k.startsWith('PG')&&k!=='NODE_TLS_REJECT_UNAUTHORIZED'));
  const prefix=path.join(operationalRoot,'app/worker/.cutover/tools/pg17/prefix');
  return {...env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGDATABASE:'postgres',PGSSLMODE:'verify-full',PGSSLROOTCERT:config.caPath,PGCONNECT_TIMEOUT:'15',PGOPTIONS:config.target==='main'?'-c default_transaction_read_only=on -c lock_timeout=5000':'-c lock_timeout=5000',LD_LIBRARY_PATH:path.join(prefix,'usr/lib/x86_64-linux-gnu')};
}
export function validateNativeArgs(target,tool,args,{ackRestore=false}={}) {
  if(!['main','restore'].includes(target)||!['pg_dump','pg_restore','psql'].includes(tool))throw new Error('NATIVE_TOOL_INVALID');
  // Connection identity belongs to this wrapper, never to CLI arguments, service files or inherited PG vars.
  if(args.some(a=>/^(?:--(?:dbname|host|port|username|role|service)(?:=|$)|-[dhpU](?:.+|$)|(?:postgres|postgresql):\/\/)/.test(a)))throw new Error('CONNECTION_OVERRIDE_FORBIDDEN');
  if(args.includes('--version')){if(args.length!==1)throw new Error('VERSION_ONLY');return;}
  if(target==='main'&&tool==='pg_restore'&&!args.some(a=>['--list','-l','--file','-f'].includes(a)||a.startsWith('--file=')))throw new Error('MAIN_RESTORE_FORBIDDEN');
  if(target==='restore'&&!ackRestore)throw new Error('RESTORE_TARGET_ACK_REQUIRED');
  if(args.some(a=>['--clean','--create','-c','-C'].includes(a))&&tool==='pg_restore')throw new Error('DESTRUCTIVE_RESTORE_OPTION_FORBIDDEN');
  if(tool==='psql'&&args.some(a=>!a.startsWith('-')&&(/^[a-z]+:\/\//i.test(a)||a==='postgres')))throw new Error('CONNECTION_OVERRIDE_FORBIDDEN');
}
export async function nativeTool({target,tool,args,ackRestore=false}) {
  validateNativeArgs(target,tool,args,{ackRestore});
  const config=operationalConfig(target),env=nativeEnvironment(config);
  const prefix=path.join(operationalRoot,'app/worker/.cutover/tools/pg17/prefix');
  const executable=path.join(prefix,'usr/lib/postgresql/17/bin',tool);
  const privateRoot=path.join(operationalRoot,'app/worker/.cutover');
  let dir;
  try {
    // Password never appears in process args, console or a persistent shell export.
    dir=mkdtempSync(path.join(privateRoot,'pg-client-'));
    const escape=s=>s.replaceAll('\\','\\\\').replaceAll(':','\\:');
    const u=new URL(config.databaseUrl),passfile=path.join(dir,'pgpass');
    writeFileSync(passfile,[env.PGHOST,env.PGPORT,env.PGDATABASE,env.PGUSER,decodeURIComponent(u.password)].map(escape).join(':')+'\n',{mode:0o600});
    env.PGPASSFILE=passfile;
    const effective=tool==='psql'?['-X','--set=ON_ERROR_STOP=on',...args]:args;
    const child=spawn(executable,effective,{env,stdio:['inherit','pipe','pipe']});
    // Logs can contain SQL/data: keep private even on failure. Never echo stderr or query output.
    const output=[],errors=[];
    child.stdout.on('data',b=>output.push(b));child.stderr.on('data',b=>errors.push(b));
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    const result=Buffer.concat(output),stderr=Buffer.concat(errors);
    if(code!==0){
      const logDir=path.join(privateRoot,'native-errors');mkdirSync(logDir,{recursive:true,mode:0o700});
      const errorFile=path.join(logDir,randomUUID()+'.stderr.log');writeFileSync(errorFile,stderr,{mode:0o600,flag:'wx'});
      throw Object.assign(new Error(),{code:'NATIVE_PG_TOOL_FAILED',exitCode:code,errorFile});
    }
    return {result,stderr,ref:config.ref,tool};
  }finally{if(dir)rmSync(dir,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const argv=process.argv.slice(2),split=argv.indexOf('--'),options=argv.slice(0,split<0?argv.length:split);
  const value=k=>{const i=options.indexOf(k);if(i<0||!options[i+1])throw new Error('CLI_ARGUMENT_REQUIRED');return options[i+1];};
  try{
    const target=value('--target'),tool=value('--tool'),args=split<0?['--version']:argv.slice(split+1);
    const out=await nativeTool({target,tool,args,ackRestore:options.includes('--ack-restore-target')});
    if(options.includes('--output'))writeFileSync(path.resolve(value('--output')),out.result,{mode:0o600,flag:'wx'});
    const version=args[0]==='--version'?out.result.toString().trim():undefined;
    console.log(JSON.stringify({status:'PASS',target,project_ref:out.ref,tool,version,certificate_verification:true,main_read_only:target==='main',output_saved:options.includes('--output')}));
  }catch(e){console.log(JSON.stringify({status:'FAIL',error_type:e.code||e.message||'NATIVE_PG_ERROR',exit_code:e.exitCode,private_error_log:e.errorFile}));process.exitCode=1;}
}
