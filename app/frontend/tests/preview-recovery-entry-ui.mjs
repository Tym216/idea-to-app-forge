import {createServer} from 'vite';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
const root=fileURLToPath(new URL('..',import.meta.url));
const server=await createServer({configFile:false,envDir:false,root,server:{host:'127.0.0.1',port:0},optimizeDeps:{entries:['tests/workspace-entry-ui.html']},
 resolve:{alias:{'@':root+'/src'}},define:{
 'import.meta.env.VITE_FORGE_ENVIRONMENT_ID':JSON.stringify('atoms-demo'),
 'import.meta.env.VITE_EXPECTED_SUPABASE_PROJECT_REF':JSON.stringify('abcdefghijklmnopqrst'),
 'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://abcdefghijklmnopqrst.supabase.co'),
 'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('offline-public-key')},esbuild:{jsx:'automatic'}});
let browser;
try{
 await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.FORGE_TEST_CHROMIUM?{executablePath:process.env.FORGE_TEST_CHROMIUM}:{})});
 const page=await browser.newPage();await page.clock.install();
 const appHTML=await readFile(new URL('./stable-app.html',import.meta.url),'utf8');
 let warning=false;const healthHeaders=[];
 let healthy=false,job=null,requests=0,reads=0,unknownReads=0,unexpected=0,detailsFail=false;
 const project={id:'p',user_id:'u',name:'Stopped preview',sandbox_id:'same-sandbox',checkpoint_id:'v1',preview_url:'https://5173-offline-fixture.daytonaproxy01.net/',workspace_revision:12,workspace_hash:'unchanged',workspace_state:'confirmed',workspace_writer:null};
 const respond=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'X-Daytona-Skip-Preview-Warning'},body:JSON.stringify(value)});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.hostname==='5173-offline-fixture.daytonaproxy01.net'){
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'X-Daytona-Skip-Preview-Warning'}});
   const isHealth=request.resourceType()==='fetch';
   if(isHealth){reads++;healthHeaders.push(request.headers()['x-daytona-skip-preview-warning']);if(unknownReads>0){unknownReads--;return route.abort('failed');}}
   if(warning||(isHealth&&request.headers()['x-daytona-skip-preview-warning']!=='true'))return route.fulfill({status:200,contentType:'text/html',headers:{'Access-Control-Allow-Origin':'*'},body:'<html><head><title>Daytona Preview - Warning</title></head><body>Preview URL Warning</body></html>'});
   if(!healthy)return respond(route,{code:'SANDBOX_NOT_RUNNING'},400);
   return route.fulfill({status:200,contentType:'text/html',headers:{'Access-Control-Allow-Origin':'*'},body:appHTML});
  }
  if(url.origin===origin)return route.continue();
  if(url.hostname!=='abcdefghijklmnopqrst.supabase.co'){unexpected++;return route.abort();}
  if(url.pathname==='/rest/v1/rpc/ita_request_preview_recovery'&&request.method()==='POST'){
   requests++;job={project_id:'p',sandbox_id:'same-sandbox',status:'queued'};return respond(route,job);
  }
  if(request.method()!=='GET'){unexpected++;return route.abort();}
  if(url.pathname==='/rest/v1/ita_projects')return respond(route,project);
  if(detailsFail&&url.pathname==='/rest/v1/ita_messages')return respond(route,{message:'unrelated detail read failed'},503);
  if(url.pathname==='/rest/v1/ita_files')return respond(route,[{path:'src/App.tsx',content:'export default function App(){return null}'}]);
  if(url.pathname==='/rest/v1/ita_preview_recoveries')return respond(route,job);
  return respond(route,[]);
 });
 await page.goto(origin+'/tests/workspace-entry-ui.html');
 await page.waitForFunction(()=>document.body.textContent.includes('正在启动预览'));
 assert.equal(requests,1,'Stopped entry must automatically enqueue recovery');
 await page.waitForTimeout(4500);assert.equal(requests,1,'Pending recovery is deduplicated across polls');
 healthy=true;job={...job,status:'ready',ready_revision:12,ready_hash:'unchanged'};
 const frame=page.frameLocator('iframe[title="应用预览"]');
 await frame.getByLabel('Task').fill('preserved');await frame.getByRole('button',{name:'Add',exact:true}).click();
 const original=await page.locator('iframe').getAttribute('src');
 await page.reload();await frame.getByText('preserved',{exact:true}).waitFor();assert.equal(requests,1);
 // A page that was already healthy must not retain that result after a later stop.
 healthy=false;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.getByText('正在启动预览…',{exact:true}).waitFor();assert.equal(requests,2);
 healthy=true;job={...job,status:'ready'};
 await frame.getByText('preserved',{exact:true}).waitFor();
 // Fetch failure (CORS/network/timeout) cannot leave a raw error iframe forever.
 unknownReads=3;await page.reload();
 await page.waitForFunction(()=>document.body.textContent.includes('正在启动预览'),{},{timeout:15000});
 assert.equal(requests,3,'Three unknown reads trigger one server-side recovery check');
 assert.equal(unknownReads,0);
 await page.waitForTimeout(4500);assert.equal(requests,3);
 job={...job,status:'ready'};await frame.getByText('preserved',{exact:true}).waitFor();
 assert.equal(await page.locator('iframe').getAttribute('src'),original);
 const priorReads=reads;
 await page.clock.fastForward(31000);
 await page.waitForFunction(()=>document.querySelector('iframe')!==null);
 await page.waitForTimeout(100);assert.ok(reads>priorReads,'Mounted preview has a bounded periodic liveness check');
 assert.equal(requests,3,'Healthy periodic checks do not enqueue recovery');
 assert.ok(healthHeaders.length>0&&healthHeaders.every(value=>value==='true'),'Health checks must bypass Daytona browser interstitials');
 warning=true;await page.reload();
 await page.getByText('正在启动预览…',{exact:true}).waitFor();assert.equal(requests,4,'Even an ignored skip header must not make a 200 interstitial healthy');
 warning=false;job={...job,status:'ready'};await frame.getByText('preserved',{exact:true}).waitFor();
 healthy=false;job=null;detailsFail=true;await page.reload();
 for(let i=0;i<60&&requests<5;i++)await page.waitForTimeout(250);
 assert.equal(requests,5,'Unrelated editor/chat reads must not prevent checkpoint preview recovery');
 assert.equal(unexpected,0);
 console.log('PASS actual Workspace stopped-runtime auto recovery, pending dedup, same-URL completion, healthy re-entry/data, later-stop focus recheck, bounded unknown-read recovery and periodic read-only liveness; zero remote operations');
}finally{await browser?.close();await server.close();}
