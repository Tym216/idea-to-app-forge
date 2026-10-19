import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const guard=await readFile(new URL('../../shared/preview-load-guard.js',import.meta.url),'utf8');
const counts=new Map(),entries=new Map();
const server=createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost'),scenario=u.searchParams.get('case')||'normal';
 if(u.pathname==='/guard.js'){res.setHeader('Content-Type','text/javascript');res.end(guard);return;}
 if(u.pathname==='/entry.js'){
  const n=(entries.get(scenario)||0)+1;entries.set(scenario,n);
  res.setHeader('Content-Type','text/javascript');
  if(['permanent','pending'].includes(scenario)||(scenario==='transient'&&n===1)){res.statusCode=503;res.end('temporary module unavailable');return;}
  res.end(`document.getElementById('root').innerHTML='<h1>App ready</h1><input aria-label="Value">';`);return;
 }
 counts.set(scenario,(counts.get(scenario)||0)+1);res.setHeader('Content-Type','text/html');
 res.end(`<!doctype html><html><body><div id="root"></div><script type="module">
 import {previewLoadGuard} from '/guard.js';
 window.__forgePreviewPhase='app-starting';window.__forgeStoragePrepareReload=()=>${scenario==='pending'?'false':'true'};
 await previewLoadGuard({projectId:${JSON.stringify(scenario)}},()=>${scenario==='timeout'?'new Promise(()=>{})':`import('/entry.js?case=${scenario}')`},{timeoutMs:700,retryDelayMs:20});
 </script></body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.FORGE_TEST_CHROMIUM?{executablePath:process.env.FORGE_TEST_CHROMIUM}:{})});
 const page=await browser.newPage();let external=0;
 await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external++;return route.abort();}return route.continue();});
 await page.goto(origin+'/?case=normal');await page.getByText('App ready',{exact:true}).waitFor();
 await page.evaluate(()=>localStorage.setItem('business','keep-progress'));
 assert.equal(counts.get('normal'),1);
 await page.goto(origin+'/?case=transient');await page.getByText('App ready',{exact:true}).waitFor();
 assert.equal(counts.get('transient'),2);assert.equal(await page.evaluate(()=>localStorage.getItem('business')),'keep-progress');
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('forge-preview-load-retry:transient')),null);
 await page.goto(origin+'/?case=permanent');await page.getByRole('button',{name:'重新加载预览',exact:true}).waitFor();
 await page.waitForTimeout(1000);assert.equal(counts.get('permanent'),2);
 assert.equal(await page.evaluate(()=>window.__forgePreviewLoadStatus),'needs_attention');
 assert.ok(!(await page.locator('body').innerText()).includes('503')); // Technical evidence stays collapsed.
 await page.getByText('加载诊断',{exact:true}).click();assert.ok((await page.locator('body').innerText()).includes('dynamically imported module'));
 await page.goto(origin+'/?case=pending');await page.getByRole('button',{name:'重新加载预览',exact:true}).waitFor();
 assert.equal(counts.get('pending'),1);await page.getByRole('button',{name:'重新加载预览',exact:true}).click();
 await page.getByText('数据仍在保存或需要核对，暂未刷新。原数据保留，请稍后重试。',{exact:true}).waitFor();assert.equal(counts.get('pending'),1);
 await page.goto(origin+'/?case=timeout');await page.getByRole('button',{name:'重新加载预览',exact:true}).waitFor();
 await page.waitForTimeout(1000);assert.equal(counts.get('timeout'),2);
 await page.goto(origin+'/?case=normal');await page.getByText('App ready',{exact:true}).waitFor();await page.getByLabel('Value').fill('user is using app');
 await page.evaluate(()=>window.dispatchEvent(new ErrorEvent('error',{error:new Error('runtime problem after render')})));
 await page.getByRole('button',{name:'重新加载预览',exact:true}).waitFor();await page.waitForTimeout(1000);
 assert.equal(counts.get('normal'),2);assert.equal(await page.getByLabel('Value').inputValue(),'user is using app');
 assert.equal(await page.evaluate(()=>localStorage.getItem('business')),'keep-progress');assert.equal(external,0);
 console.log('PASS local preview load guard: normal no reload, transient one reload, permanent/timeout bounded, saved data retained, pending saves block navigation, post-render runtime error never auto reloads, zero external requests');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
