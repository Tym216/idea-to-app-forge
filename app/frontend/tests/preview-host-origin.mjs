import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {previewBootstrap,appStorageKey} from '../../shared/preview-storage.js';
const shared=await readFile(new URL('../../shared/preview-storage.js',import.meta.url),'utf8');
const identity={environment:'demo',ref:'demo',userId:'user-a',projectId:'project-a'};
let hostOrigin,childOrigin;
const host=createServer((req,res)=>{
 const u=new URL(req.url,'http://local');
 if(u.pathname==='/bridge.js'){res.setHeader('Content-Type','text/javascript');res.end(shared);return;}
 res.setHeader('Content-Type','text/html');
 if(u.pathname==='/setup'){res.end('<html><body>setup</body></html>');return;}
 res.end(`<html><body><output id="status"></output><iframe title="app" ${u.searchParams.has('private')?'referrerpolicy="no-referrer"':''}></iframe><script type="module">
 import {attachPreviewStorage} from '/bridge.js';const frame=document.querySelector('iframe');
 attachPreviewStorage({frame,origin:${JSON.stringify(childOrigin)},identity:${JSON.stringify(identity)},onStatus:s=>document.querySelector('#status').textContent=s});
 frame.src=new URLSearchParams(location.search).get('child');</script></body></html>`);
});
const child=createServer((req,res)=>{
 const u=new URL(req.url,'http://local');
 if(u.pathname==='/hop'){res.setHeader('Content-Type','text/html');res.end('<html><body><script>location.replace("/?after=proxy-hop")</script></body></html>');return;}
 if(u.pathname==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(`document.querySelector('#root').textContent='App ready: '+localStorage.getItem('progress');window.appLaunched=true;`);return;}
 res.setHeader('Content-Type','text/html');res.end(`<html><body><div id="root"></div><script type="module">
 try{await (${previewBootstrap.toString()})({hostOrigin:${JSON.stringify(hostOrigin)},projectId:'project-a',allowLocalValidation:false},[{src:'/app.js'}]);}
 catch(error){window.bootError=error.message;}
 </script></body></html>`);
});
const foreign=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<html><body><iframe src="${childOrigin}/hop"></iframe></body></html>`);});
for(const s of [host,child,foreign])await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
hostOrigin='http://127.0.0.1:'+host.address().port;childOrigin='http://127.0.0.1:'+child.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.FORGE_TEST_CHROMIUM?{executablePath:process.env.FORGE_TEST_CHROMIUM}:{})});
 const page=await browser.newPage();let external=0;
 await page.route('**/*',route=>{if(!route.request().url().startsWith('http://127.0.0.1:')){external++;return route.abort();}return route.continue();});
 const key=appStorageKey(identity);await page.goto(hostOrigin+'/setup');
 const original=JSON.stringify({schema:1,revision:4,entries:{progress:'42'}});await page.evaluate(({key,original})=>localStorage.setItem(key,original),{key,original});
 async function context(){
  const frame=page.frames().find(f=>f.url().startsWith(childOrigin)&&new URL(f.url()).pathname==='/');
  if(!frame)throw Error('no final child frame');
  await frame.waitForFunction(()=>window.appLaunched||window.bootError);
  return frame.evaluate(()=>({error:window.bootError,launched:window.appLaunched||false,referrer:document.referrer,ancestor:location.ancestorOrigins?.[0],text:document.querySelector('#root').textContent}));
 }
 await page.goto(hostOrigin+'/?child='+encodeURIComponent(childOrigin+'/hop'));
 await page.frameLocator('iframe').locator('#root').waitFor({state:'attached'});const hopped=await context();
 console.log('proxy-hop-context',JSON.stringify(hopped));
 assert.equal(new URL(hopped.referrer).origin,childOrigin);assert.equal(hopped.ancestor,hostOrigin);
 assert.equal(hopped.error,undefined,'trusted parent after proxy navigation must not fail based on document.referrer');
 assert.equal(hopped.text,'App ready: 42');assert.equal(await page.evaluate(k=>localStorage.getItem(k),key),original);
 await page.reload();await page.frameLocator('iframe').getByText('App ready: 42',{exact:true}).waitFor();
 await page.goto(hostOrigin+'/?private&child='+encodeURIComponent(childOrigin));await page.frameLocator('iframe').locator('#root').waitFor({state:'attached'});
 const privateContext=await context();assert.equal(privateContext.referrer,'');assert.equal(privateContext.launched,true);
 await page.goto('http://127.0.0.1:'+foreign.address().port+'/');await page.frameLocator('iframe').locator('#root').waitFor({state:'attached'});
 const denied=await context();assert.equal(denied.error,'APP_STORAGE_HOST_MISMATCH');assert.equal(denied.launched,false);
 await page.goto(hostOrigin+'/setup');assert.equal(await page.evaluate(k=>localStorage.getItem(k),key),original);assert.equal(external,0);
 console.log('PASS actual cross-origin host authentication: proxy/client navigation and private referrer preserve data with no reload workaround; foreign ancestor denied before App launch; zero external requests');
}finally{await browser?.close();for(const s of [host,child,foreign])await new Promise(resolve=>s.close(resolve));}
