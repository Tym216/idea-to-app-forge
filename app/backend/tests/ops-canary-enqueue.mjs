/** Trusted administrator-only canary business command; never grants client EXECUTE or edits execution state. */
import {readFileSync} from 'node:fs';
import {connectOperational,verifyFrozen} from './ops-ingress-gate.mjs';
const args=process.argv.slice(2),value=n=>{const i=args.indexOf(n);if(i<0||!args[i+1]||args[i+1].startsWith('--'))throw Object.assign(new Error(),{code:'CLI_ARGUMENT_REQUIRED'});return args[i+1];};let db;
try {
 const target=value('--target'),mode=value('--mode'),user=value('--user'),project=value('--project');
 if(!/^[a-f0-9-]{36}$/i.test(user||'')||!/^[a-f0-9-]{36}$/i.test(project||''))throw Object.assign(new Error(),{code:'CANARY_ID_INVALID'});
 const c=await connectOperational(target,{ackMain:args.includes('--ack-main-maintenance')});db=c.db;await verifyFrozen(db);
 if((await db.query('select id from auth.users where id=$1',[user])).rows.length!==1)throw Object.assign(new Error(),{code:'CANARY_USER_NOT_FOUND'});
 await db.query('BEGIN');await db.query('select set_config($1,$2,true)',['request.jwt.claims',JSON.stringify({sub:user})]);
 let result;
 if(mode==='plan') {
  const prompt=readFileSync(value('--prompt-file'),'utf8').trim();if(!prompt||prompt.length>4000)throw Object.assign(new Error(),{code:'CANARY_PROMPT_INVALID'});
  await db.query('insert into public.ita_projects(id,user_id,name) values($1,$2,$3)',[project,user,'Controlled cutover canary']);
  result=(await db.query("insert into public.ita_tasks(project_id,user_id,mode,prompt) values($1,$2,'plan',$3) returning id,status,mode",[project,user,prompt])).rows[0];
 } else if(mode==='approve') {
  const plan=value('--plan'),version=Number(value('--version'));
  const owned=await db.query('select id from public.ita_plans where id=$1 and project_id=$2 and user_id=$3',[plan,project,user]);if(owned.rows.length!==1||!Number.isInteger(version))throw Object.assign(new Error(),{code:'CANARY_PLAN_INVALID'});
  result=(await db.query('select to_jsonb(public.ita_approve_plan($1,$2)) task',[plan,version])).rows[0].task;
 } else throw Object.assign(new Error(),{code:'CANARY_MODE_INVALID'});
 await verifyFrozen(db);await db.query('COMMIT');
 console.log(JSON.stringify({status:'PASS',target,project_id:project,task_id:result.id,task_status:result.status,task_mode:result.mode,client_gate_still_frozen:true}));
}catch(e){if(db)await db.query('ROLLBACK').catch(()=>{});console.log(JSON.stringify({status:'FAIL',error_type:e.code||'CANARY_COMMAND_FAILED'}));process.exitCode=1;}
finally{if(db)await db.end();}
