import {createServer} from 'vite';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {renderPersistenceHelper,PERSISTENCE_HOOK_SOURCE} from '../../worker/src/app-persistence.js';
const root=fileURLToPath(new URL('..',import.meta.url));
const server=await createServer({configFile:false,envDir:false,root,server:{host:'127.0.0.1',port:0},optimizeDeps:{entries:['tests/persistence-ui.html']},esbuild:{jsx:'automatic'},plugins:[{
 name:'generated-persistence-fixture',
 resolveId(id,importer){
  if(id==='virtual:forge-hook')return '\0forge-hook';
  if(id==='./forge-persistence'&&importer==='\0forge-hook')return '\0forge-state';
 },
 load(id){if(id==='\0forge-hook')return PERSISTENCE_HOOK_SOURCE;if(id==='\0forge-state')return renderPersistenceHelper('atoms-demo','demo-game');}
}]});
let browser;
try{
 await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.FORGE_TEST_CHROMIUM?{executablePath:process.env.FORGE_TEST_CHROMIUM}:{})});
 const page=await browser.newPage();let external=0;
 await page.route('**/*',r=>{if(!r.request().url().startsWith(origin)){external++;return r.abort();}return r.continue();});
 await page.goto(origin+'/tests/persistence-ui.html');
 const value=async()=>JSON.parse(await page.getByTestId('game').textContent());
 await page.getByRole('button',{name:'Play',exact:true}).click();
 const played=await value();assert.equal(played.score,10);assert.deepEqual(played.snake,[[2,1]]);
 const key='forge:atoms-demo:demo-game:game';
 const bytes=await page.evaluate(k=>localStorage.getItem(k),key);
 assert.equal(JSON.parse(bytes).value.score,10); // Synchronous write, not a later effect.
 await page.reload();assert.deepEqual(await value(),played);
 await page.getByRole('button',{name:'Logout',exact:true}).click();await page.getByTestId('game').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Login',exact:true}).click();assert.deepEqual(await value(),played);
 await page.goto(origin+'/tests/persistence-ui.html?code-version=2');assert.deepEqual(await value(),played);
 await page.evaluate(()=>localStorage.setItem('unrelated-data','keep'));
 page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'重置业务数据',exact:true}).click();assert.deepEqual(await value(),played);
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'重置业务数据',exact:true}).click();assert.equal((await value()).score,0);
 assert.equal(await page.evaluate(()=>localStorage.getItem('unrelated-data')),'keep');
 await page.evaluate(k=>localStorage.setItem(k,'{bad'),key);await page.reload();
 assert.equal(await page.getByTestId('status').textContent(),'blocked');
 await page.getByRole('button',{name:'Play',exact:true}).click();assert.equal(await page.evaluate(k=>localStorage.getItem(k),key),'{bad');
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'重置业务数据',exact:true}).click();assert.equal((await value()).score,0);
 assert.equal(external,0);
 console.log('PASS generated persistence hook: complete snapshot, synchronous save, reload/logout/code-version continuity, scoped explicit reset, malformed-data protection; local fixture only');
}finally{await browser?.close();await server.close();}
