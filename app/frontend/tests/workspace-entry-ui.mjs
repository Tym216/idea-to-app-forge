import {createServer} from 'vite';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
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
 const page=await browser.newPage();let detailsDelivered=0,mutations=0;
 const project={id:'p',user_id:'u',name:'Preview first',sandbox_id:'s',checkpoint_id:'v1',preview_url:origin+'/tests/stable-app.html',workspace_revision:1,workspace_hash:'hash',workspace_state:'confirmed',workspace_writer:null};
 await page.route('**/*',async route=>{
  const r=route.request(),url=new URL(r.url());if(url.origin===origin)return route.continue();
  if(r.method()!=='GET'){mutations++;return route.abort();}
  if(url.pathname==='/rest/v1/ita_projects')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(project)});
  await new Promise(resolve=>setTimeout(resolve,2500));detailsDelivered++;
  return route.fulfill({status:200,contentType:'application/json',body:'[]'});
 });
 await page.goto(origin+'/tests/workspace-entry-ui.html',{waitUntil:'domcontentloaded'});
 await page.locator('iframe[title="应用预览"]').waitFor();
 assert.equal(detailsDelivered,0,'Preview must not await messages/files/plans/versions');
 const frame=page.frameLocator('iframe[title="应用预览"]');
 await frame.getByLabel('Task').fill('saved');await frame.getByRole('button',{name:'Add',exact:true}).click();
 await page.getByText('Preview first',{exact:true}).waitFor();
 const iframe=page.locator('iframe');await iframe.evaluate(el=>el.dataset.marker='kept');
 await frame.getByLabel('Task').fill('in-memory input');
 await page.getByRole('tab',{name:/代码/}).click();
 await page.getByRole('tab',{name:/预览/}).click();
 assert.equal(await iframe.getAttribute('data-marker'),'kept');assert.equal(await frame.getByLabel('Task').inputValue(),'in-memory input');
 await page.getByRole('button',{name:'检查并刷新预览',exact:true}).click();await frame.getByText('saved',{exact:true}).waitFor();
 assert.equal(mutations,0,'Healthy refresh must not request recovery');
 assert.equal(await iframe.getAttribute('src'),project.preview_url);
 console.log('PASS actual Workspace: Preview before delayed details; tab changes retain iframe; healthy refresh keeps URL/data with zero recovery mutation');
}finally{await browser?.close();await server.close();}
