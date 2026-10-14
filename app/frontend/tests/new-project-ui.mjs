import {createServer} from 'vite';import {chromium} from 'playwright';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),ref='abcdefghijklmnopqrst';
const server=await createServer({configFile:false,envDir:false,root,server:{host:'127.0.0.1',port:0},resolve:{alias:{'@':root+'/src'}},define:Object.fromEntries(Object.entries({VITE_FORGE_ENVIRONMENT_ID:'atoms-demo',VITE_EXPECTED_SUPABASE_PROJECT_REF:ref,VITE_SUPABASE_URL:'https://'+ref+'.supabase.co',VITE_SUPABASE_ANON_KEY:'offline-public-key'}).map(([k,v])=>['import.meta.env.'+k,JSON.stringify(v)])),optimizeDeps:{entries:['tests/new-project-ui.html']},esbuild:{jsx:'automatic'}});
const user={id:'fixture-user',aud:'authenticated',role:'authenticated',email:'local-fixture@example.test'};
const jwt=Buffer.from(JSON.stringify({alg:'HS256'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated',aud:'authenticated'})).toString('base64url')+'.offline';
const project={id:'new-project',user_id:user.id,name:'New App',description:'Create a test Todo',status:'idle',sandbox_id:null,checkpoint_id:null,workspace_revision:0,workspace_hash:'empty',workspace_state:'confirmed',workspace_writer:null,created_at:'2026-10-14T00:00:00Z'};
const task={id:'task',project_id:project.id,user_id:user.id,mode:'plan',operation:'agent',status:'queued',phase:'queued',plan:[],steps:[],created_at:'2026-10-14T00:00:01Z',prompt:project.description,plan_id:null};
const plan={id:'initial',project_id:project.id,user_id:user.id,source_task_id:task.id,version:1,kind:'plan',status:'draft',created_at:'2026-10-14T00:00:02Z',content:{understanding:'A Todo',scope:['Add items'],flows:['Add a task'],rules:[],storage:'Browser',steps:['Implement Todo'],design:'Simple',questions:[],acceptance:[]}};
let browser;
try{
 await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.FORGE_TEST_CHROMIUM?{executablePath:process.env.FORGE_TEST_CHROMIUM}:{})});
 for(const mode of ['healthy','recoverable','persistent']){
  const page=await browser.newPage({viewport:{width:1365,height:768}});let created=false,submissions=0,reads=0,planReads=0,renderErrors=0,planInFlight=0,maxPlanInFlight=0,delayed=false;const unexpected=[];
  page.on('pageerror',e=>unexpected.push(e.message));page.on('console',msg=>{if(msg.text().includes('WORKSPACE_RENDER_ERROR'))renderErrors++;});
  await page.addInitScript(({ref,jwt,user})=>localStorage.setItem('sb-'+ref+'-auth-token',JSON.stringify({access_token:jwt,refresh_token:'offline',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user})),{ref,jwt,user});
  await page.route('**/*',async route=>{
   const q=route.request(),u=new URL(q.url());if(u.origin===origin)return route.continue();
   if(u.hostname!==ref+'.supabase.co')return route.abort();
   const send=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
   if(u.pathname==='/auth/v1/user')return send(user);
   if(q.method()==='POST'){
    if(u.pathname==='/rest/v1/ita_projects'){created=true;return send(project);}
    if(u.pathname==='/rest/v1/ita_messages')return send(null);
    if(u.pathname==='/rest/v1/ita_tasks'){submissions++;return send(task);}
    throw Error('UNEXPECTED_MUTATION '+u.pathname);
   }
   if(u.pathname==='/rest/v1/ita_projects')return send(created?project:[]);
   if(u.pathname==='/rest/v1/ita_tasks'){
    if(!submissions)return send([]);reads++;
    return send([{...task,status:reads<2?'running':'succeeded',phase:reads<2?'planning':'done',steps:[{tool:'llm',event:reads<2?'started':'finished',observation:'Model call',at:'2026-10-14T00:00:02Z'}]}]);
   }
   if(u.pathname==='/rest/v1/ita_messages')return send(submissions?[{id:'message',project_id:project.id,role:'user',content:project.description,created_at:'2026-10-14T00:00:00Z'}]:[]);
   if(u.pathname==='/rest/v1/ita_plans'){
    planInFlight++;maxPlanInFlight=Math.max(maxPlanInFlight,planInFlight);
    if(mode==='healthy'&&!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,5200));}
    planInFlight--;
    if(reads<2)return send([]);planReads++;
    const invalid=mode==='persistent'||mode==='recoverable'&&planReads===1;
    return send([{...plan,content:{...plan.content,design:invalid?{unexpected:'structure'}:plan.content.design}}]);
   }
   if(u.pathname.includes('/rest/v1/'))return send([]);return route.abort();
  });
  await page.goto(origin+'/tests/new-project-ui.html');await page.getByPlaceholder('例如:做一个支持分类和本地存储的待办清单').fill(project.description);await page.getByRole('button',{name:'新建项目',exact:true}).click();
  if(mode==='persistent'){
   await page.getByRole('heading',{name:'工作区显示暂时异常',exact:true}).waitFor({timeout:20000});
   const count=planReads;await page.waitForTimeout(1600);assert.equal(planReads,count,'automatic retry is bounded');
   assert.equal(submissions,1);assert.equal(await page.getByRole('button',{name:'重新读取项目',exact:true}).isVisible(),true);
   await page.getByRole('button',{name:'返回项目列表',exact:true}).click();await page.getByRole('heading',{name:'用一句话描述你想要的应用'}).waitFor();
  }else{
   await page.getByRole('heading',{name:'计划 v1',exact:true}).waitFor({timeout:20000});
   await page.getByRole('button',{name:'批准 v1 并构建',exact:true}).waitFor();
   assert.equal(submissions,1,'display recovery must never resubmit a model task');
   assert.equal(await page.getByRole('button',{name:'返回项目列表',exact:true}).isVisible(),true);
   if(mode==='recoverable'){
    assert.ok(renderErrors>0);const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('forge-workspace-ui-errors')||'[]'));assert.ok(saved.length);assert.equal(saved.at(-1).projectId,project.id);await page.getByText('开发者诊断与任务详情',{exact:true}).click();await page.getByText('工作区显示恢复记录（1）',{exact:true}).waitFor();
   }else {assert.equal(renderErrors,0);assert.equal(maxPlanInFlight,1,'slow metadata must not overlap another workspace read');}
   assert.equal(await page.evaluate(()=>scrollY),0);
  }
  if(mode==='healthy')assert.deepEqual(unexpected,[]);else assert.ok(unexpected.every(message=>message.includes('Objects are not valid as a React child')&&message.includes('unexpected')),'only the injected React error is allowed');await page.close();
 }
 console.log('PASS first-create lifecycle: real Home → Workspace → queued/running/Plan, automatic render recovery without duplicate task, bounded repeated failure with usable navigation/local diagnostics, zero remote operations');
}finally{await browser?.close();await server.close();}
