
import {createServer} from 'vite';
import {createServer as httpServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createPreviewPlugin,renderPreviewConfig} from '../../worker/src/preview-platform.js';
import {previewBootstrap,appStorageKey,resetPreviewStorage} from '../../shared/preview-storage.js';
const root=await mkdtemp(path.join(os.tmpdir(),'forge-cross-origin-'));
const identity={environment:'demo',ref:'demo',userId:'user-a',projectId:'project-a'};
const html='<!doctype html><html><head><script type="module">window.inlineReady=true;</script></head><body><input aria-label="Item"><button id="add">Add</button><ul id="list"></ul><script type="module" src="./app.js"></script></body></html>';
const code=`
let items=JSON.parse(localStorage.getItem('items')||'[]');
const render=()=>document.querySelector('#list').textContent=items.join(', ');
document.querySelector('#add').onclick=()=>{items.push(document.querySelector('input').value);localStorage.setItem('items',JSON.stringify(items));render();};
render();window.appLaunched=true;
`;
await writeFile(path.join(root,'index.html'),html);await writeFile(path.join(root,'app.js'),code);
const shared=await readFile(new URL('../../shared/preview-storage.js',import.meta.url),'utf8');
const host=httpServer((req,res)=>{
 if(req.url==='/bridge.js'){res.setHeader('Content-Type','text/javascript');res.end(shared);return;}
 res.setHeader('Content-Type','text/html');
 res.end(`<html><body><output id="status"></output><iframe title="app"></iframe><script type="module">
 import {attachPreviewStorage} from '/bridge.js';
 const args=new URLSearchParams(location.search),frame=document.querySelector('iframe');
 const identity=${JSON.stringify(identity)};
 identity.projectId=args.get('project')||identity.projectId;identity.userId=args.get('user')||identity.userId;
 attachPreviewStorage({frame,origin:new URL(args.get('child')).origin,identity,onStatus:s=>document.querySelector('#status').textContent=s});
 frame.src=args.get('child');
 </script></body></html>`);
});
await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));
const hostOrigin='http://127.0.0.1:'+host.address().port;
const children=[];
await symlink(new URL('../node_modules',import.meta.url).pathname,path.join(root,'node_modules'),'dir');
await writeFile(path.join(root,'vite.config.mjs'),'export default {plugins:[{name:"original-preserved",transformIndexHtml(html){return html.replace("<body>","<body data-original=retained>")}}]};');
await mkdir(path.join(root,'.forge-preview'));
const wrapper=renderPreviewConfig({environmentId:'atoms-demo',forgePublicOrigin:hostOrigin},{projectId:'project-a'});
await writeFile(path.join(root,'.forge-preview/vite.config.mjs'),wrapper.replace('"allowLocalValidation":true','"allowLocalValidation":false'));

let browser;
try{
 for(let i=0;i<2;i++){
  const previous=process.cwd();let server;
  try{process.chdir(root);server=await createServer({root,configFile:i===1?path.join(root,'.forge-preview/vite.config.mjs'):false,envDir:false,optimizeDeps:{noDiscovery:true},
   server:{host:'127.0.0.1',port:0},...(i===0?{plugins:[createPreviewPlugin({hostOrigin,projectId:'project-a',allowLocalValidation:false},previewBootstrap.toString())]}:{})});
  }finally{process.chdir(previous);}
  await server.listen();children.push(server);
 }
 const origins=children.map(s=>'http://127.0.0.1:'+s.httpServer.address().port);
 assert.notEqual(origins[0],origins[1]);
 browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.FORGE_TEST_CHROMIUM?{executablePath:process.env.FORGE_TEST_CHROMIUM}:{})});
 const page=await browser.newPage();let remote=0;
 await page.route('**/*',route=>{if(!route.request().url().startsWith('http://127.0.0.1:')){remote++;return route.abort();}return route.continue();});
 const visit=async(child,extra='')=>{await page.goto(hostOrigin+'/?child='+encodeURIComponent(child)+'&'+extra);await page.locator('#status').filter({hasText:'ready'}).waitFor();};
 const frame=()=>page.frameLocator('iframe');
 await visit(origins[0]);await page.frames()[1].waitForFunction(()=>window.inlineReady===true);await frame().getByLabel('Item').fill('preserved');await frame().getByRole('button',{name:'Add'}).click();await page.locator('#status').filter({hasText:'saved'}).waitFor();
 const storeKey=appStorageKey(identity);
 const original=await page.evaluate(k=>localStorage.getItem(k),storeKey);
 await page.reload();await frame().locator('#list').filter({hasText:'preserved'}).waitFor();
 await visit(origins[1]);await frame().locator('#list').filter({hasText:'preserved'}).waitFor();assert.equal(await frame().locator('body').getAttribute('data-original'),'retained');
 await visit(origins[0],'project=project-b');assert.equal(await frame().locator('#list').textContent(),'');
 await visit(origins[1],'user=user-b');assert.equal(await frame().locator('#list').textContent(),'');
 await visit(origins[1]);await frame().locator('#list').filter({hasText:'preserved'}).waitFor();
 await page.evaluate(()=>window.postMessage({protocol:'forge-preview-storage-v1',channel:'1234567890123456',op:'hello',legacy:{items:'["attacker"]'}},location.origin));
 assert.equal(await page.evaluate(k=>localStorage.getItem(k),storeKey),original);
 await page.evaluate(k=>{const state=JSON.parse(localStorage.getItem(k));state.revision++;state.entries.items='["other preview"]';localStorage.setItem(k,JSON.stringify(state));},storeKey);
 await frame().getByLabel('Item').fill('stale');await frame().getByRole('button',{name:'Add'}).click();await page.locator('#status').filter({hasText:'error'}).waitFor();
 assert.match(await page.evaluate(k=>localStorage.getItem(k),storeKey),/other preview/);
 await page.evaluate(k=>localStorage.setItem(k,'{malformed'),storeKey);await page.reload();
 await page.locator('#status').filter({hasText:'error'}).waitFor();
 assert.equal(await page.evaluate(k=>localStorage.getItem(k),storeKey),'{malformed');
 assert.equal(await page.frames()[1].evaluate(()=>window.appLaunched||false),false);
 await page.evaluate(async k=>{
 const {resetPreviewStorage}=await import('/bridge.js');
 await resetPreviewStorage({environment:'demo',ref:'demo',userId:'user-a',projectId:'project-a'});
 },storeKey);
 await page.reload();await page.frames()[1].waitForFunction(()=>window.appLaunched===true);assert.equal(await frame().locator('#list').textContent(),'');
 assert.equal(remote,0);
 console.log('PASS cross-origin platform persistence: real Vite bootstrap before App, raw localStorage survives origin change/refresh/account re-entry, project+account isolation, foreign-message rejection, stale CAS and corrupt-data fail closed, zero remote calls');
}finally{
 await browser?.close();for(const s of children)await s.close();await new Promise(resolve=>host.close(resolve));await rm(root,{recursive:true,force:true});
}
