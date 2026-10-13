import {createServer} from 'vite';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {renderPersistenceHelper} from '../../worker/src/app-persistence.js';
const root=fileURLToPath(new URL('..',import.meta.url));
const server=await createServer({configFile:false,envDir:false,root,server:{host:'127.0.0.1',port:0},resolve:{alias:{'@':root+'/src'}},define:{
 'import.meta.env.VITE_FORGE_ENVIRONMENT_ID':JSON.stringify('atoms-demo'),
 'import.meta.env.VITE_EXPECTED_SUPABASE_PROJECT_REF':JSON.stringify('abcdefghijklmnopqrst'),
 'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://abcdefghijklmnopqrst.supabase.co'),
 'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('offline-public-key')
},esbuild:{jsx:'automatic'}});
let browser;
try {
 await server.listen();const port=server.httpServer.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.FORGE_TEST_CHROMIUM ? {executablePath:process.env.FORGE_TEST_CHROMIUM} : {})});
 const page=await browser.newPage();let external=0;
 await page.route('**/*',route=>{const url=route.request().url();
 if(url.startsWith('https://abcdefghijklmnopqrst.supabase.co/rest/v1/ita_task_feedback')&&route.request().method()==='GET')return route.fulfill({status:200,contentType:'application/json',body:'[]'});
 if(!url.startsWith('http://127.0.0.1:')&&!url.startsWith('data:')){external++;return route.abort();}return route.continue();});
 await page.goto('http://127.0.0.1:'+port+'/tests/demo-ui.html');
 const probe=page.getByTestId('recovery-probe');
 await probe.getByText('正在启动预览…',{exact:true}).waitFor();
 assert.equal(await page.getByTestId('recovery-requests').textContent(),'1');
 for(let n=0;n<3;n++)await probe.getByRole('button',{name:'Poll preview'}).click();
 assert.equal(await page.getByTestId('recovery-requests').textContent(),'1');
 assert.equal(await probe.locator('iframe').count(),0);
 const customerText=await probe.innerText();
 assert.ok(!customerText.includes('INTERNAL_BODY_DUMP'));assert.ok(!customerText.includes('locator.click'));
 await probe.getByText('开发者诊断 · 浏览器验收',{exact:true}).click();
 assert.ok((await probe.innerText()).includes('INTERNAL_BODY_DUMP'));
 await probe.getByText('开发者诊断 · 浏览器验收',{exact:true}).click();
 const editor=page.getByRole('textbox',{name:'编辑 src/App.tsx'});
 // An authoritative no-op receipt is terminal, not an applying state with a missing task.
 await editor.fill('already-current-on-server');
 await page.getByRole('button',{name:'Return no-op',exact:true}).click();
 await page.getByRole('button',{name:'Apply Changes'}).click();
 await page.getByRole('status').filter({hasText:'没有需要应用的更改'}).waitFor();
 assert.equal(await page.getByTestId('code-probe').getByRole('status').filter({hasText:/等待 Worker|Worker 正在应用/}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Apply Changes'}).isDisabled(),true);
 await page.reload();await editor.fill('edited');
 assert.equal(await page.getByTestId('submissions').textContent(),'0');
 await page.getByRole('button',{name:'Toggle active'}).click();assert.equal(await page.getByRole('button',{name:'Apply Changes'}).isDisabled(),true);
 await page.getByRole('button',{name:'Toggle active'}).click();
 await page.getByRole('button',{name:'Apply Changes'}).click();await page.getByRole('status').filter({hasText:'Worker 正在应用'}).waitFor();
 assert.equal(await page.getByTestId('submissions').textContent(),'1');
 await page.getByRole('button',{name:'Complete',exact:true}).click();await page.getByRole('status').filter({hasText:'修改已应用'}).waitFor();
 await page.getByRole('alert').waitFor({state:'hidden',timeout:3000});
 assert.equal(await page.getByRole('alert').count(),0);
 await editor.fill('second draft');
 await page.getByRole('button',{name:'Change revision'}).click();assert.equal(await page.getByRole('button',{name:'Apply Changes'}).isDisabled(),true);
 await page.getByRole('alert').filter({hasText:'Workspace changed'}).waitFor();
 assert.equal(await page.getByTestId('default-mode').textContent(),'build');assert.equal(await page.getByTestId('stable').textContent(),'false');
 assert.equal(await page.getByTestId('old-preview').textContent(),'false');assert.equal(await page.locator('iframe').count(),0);
 await page.getByRole('button',{name:'App v1 · Current · Initial app'}).click();await page.getByText('historical',{exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox').count(),3); // Historical code is pre, never a second editor.
 await page.getByText('历史源码只读。',{exact:false}).waitFor();
 // Real browser reload persistence, using the generated helper, on the same local origin.
 const helper=renderPersistenceHelper('atoms-demo','project');
 await page.evaluate(async source=>{const m=await import('data:text/javascript;base64,'+btoa(source));m.createAppState('todos',{initialValue:[]}).write(['retained']);},helper);
 await page.reload();
 const restored=await page.evaluate(async source=>{const m=await import('data:text/javascript;base64,'+btoa(source));return m.createAppState('todos',{initialValue:[]}).read();},helper);
 assert.deepEqual(restored.value,['retained']);assert.equal(external,0);
 console.log('PASS local Chromium UI: draft/no remote writes, active disabled, no-op terminal/no phantom task, accepted/applying/completed, stale, version readonly, stable-vs-working/old iframe, browser reload persistence; no external requests');
} finally {await browser?.close();await server.close();}
