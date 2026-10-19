import {createServer} from 'vite';import {chromium} from 'playwright';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const server=await createServer({configFile:false,envDir:false,root,server:{host:'127.0.0.1',port:0},resolve:{alias:{'@':root+'/src'}},define:{
 'import.meta.env.VITE_FORGE_ENVIRONMENT_ID':JSON.stringify('atoms-demo'),
 'import.meta.env.VITE_EXPECTED_SUPABASE_PROJECT_REF':JSON.stringify('abcdefghijklmnopqrst'),
 'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://abcdefghijklmnopqrst.supabase.co'),
 'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('offline-public-key')},optimizeDeps:{entries:['tests/product-ui.html']},esbuild:{jsx:'automatic'}});
let browser;try{
 await server.listen();const port=server.httpServer.address().port;browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.FORGE_TEST_CHROMIUM?{executablePath:process.env.FORGE_TEST_CHROMIUM}:{})});
 const page=await browser.newPage();let mutations=0;
 await page.route('**/*',route=>{const r=route.request(),u=new URL(r.url());if(u.origin==='http://127.0.0.1:'+port)return route.continue();
 if(r.method()!=='GET'){mutations++;return route.abort();}
 if(u.pathname==='/rest/v1/ita_snapshots')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:'v1',project_id:'p',version_number:1,parent_checkpoint_id:null,files:[{path:'src/App.tsx',content:'Original string'}],created_at:'now'})});
 if(u.pathname==='/rest/v1/ita_task_feedback')return route.fulfill({status:200,contentType:'application/json',body:'[]'});
 return route.abort();});
 await page.goto('http://127.0.0.1:'+port+'/tests/product-ui.html');
 const conversation=page.getByLabel('项目对话');
 await conversation.getByText('把背景改成蓝色',{exact:true}).waitFor();
 const proof=JSON.parse(await page.getByTestId('projection-proof').textContent());
 assert.ok(proof.repairFriendly&&proof.repairProgress&&proof.activityFriendly);assert.equal(proof.oneTaskAssistant,1);assert.ok(proof.stableTurnId&&proof.progressChanged&&proof.noRaw&&proof.initialOneTurn);assert.equal(proof.intentTitle,'把背景改成蓝色');
 assert.equal(await page.locator('[data-forge-turn]').count(),2);
 assert.equal(await page.locator('details[aria-label=执行详情][open]').count(),0);
await conversation.getByText('把背景改成蓝色',{exact:true}).waitFor();
 const details=conversation.locator('details').first();await details.locator('summary').click();assert.equal(await details.getAttribute('open'),'');await details.locator('summary').click();assert.equal(await details.getAttribute('open'),null);
 assert.ok(!(await page.locator('body').innerText()).includes('INTERNAL'));assert.ok(!(await page.locator('body').innerText()).includes('locator.click'));
 await conversation.getByRole('button',{name:'Version 1 · Initial app',exact:true}).click();await page.getByText('Original string',{exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'编辑 src/App.tsx'}).count(),0);
 await page.reload();await page.getByText('Original string',{exact:true}).waitFor();await conversation.getByText('把背景改成蓝色',{exact:true}).waitFor();
 await conversation.getByRole('button',{name:'Version 2 · 把背景改成蓝色 · Current',exact:true}).click();
 const editor=page.getByRole('textbox',{name:'编辑 src/App.tsx'});assert.equal(await editor.inputValue(),'Blue string');
 const actionStyles=await page.getByRole('button',{name:'保存草稿',exact:true}).evaluate(el=>({background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderColor}));
 assert.notEqual(actionStyles.background,'rgb(255, 255, 255)');assert.notEqual(actionStyles.background,'rgba(0, 0, 0, 0)');
 await editor.fill('saved local draft');await page.getByRole('button',{name:'保存草稿',exact:true}).click();await page.reload();await page.getByRole('tab',{name:/代码/}).click();assert.equal(await editor.inputValue(),'saved local draft');
 assert.equal(await page.getByTestId('submissions').textContent(),'0');await page.getByRole('button',{name:'Reload / discard draft'}).click();
 await page.getByRole('textbox',{name:'新文件路径'}).fill('src/note.ts');await page.getByRole('button',{name:'Add File',exact:true}).click();
 await page.getByRole('textbox',{name:'编辑 src/note.ts'}).fill('export const note = 1;');assert.equal(await page.getByTestId('submissions').textContent(),'0');
 await page.getByRole('button',{name:'删除文件',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'编辑 src/note.ts'}).count(),0);
 // An Apply can complete while the browser is closed: identical saved targets
 // must not remain stale after reload. A genuinely different stale draft survives.
 const draftKey='forge-editor-draft:abcdefghijklmnopqrst:p';
 await page.evaluate(k=>localStorage.setItem(k,JSON.stringify({schema:1,base:1,active:'src/App.tsx',drafts:{'src/App.tsx':'Blue string'}})),draftKey);
 await page.reload();await page.getByRole('tab',{name:/代码/}).click();await editor.waitFor();
 assert.equal(await editor.inputValue(),'Blue string');
 assert.equal(await page.evaluate(k=>localStorage.getItem(k),draftKey),null);
 assert.ok(!(await page.locator('body').innerText()).includes('Workspace changed.'));
 assert.equal(await page.getByRole('button',{name:'Add File',exact:true}).isEnabled(),true);
 await page.evaluate(k=>localStorage.setItem(k,JSON.stringify({schema:1,base:1,active:'src/App.tsx',drafts:{'src/App.tsx':'still pending'}})),draftKey);
 await page.reload();await page.getByRole('tab',{name:/代码/}).click();await editor.waitFor();
 assert.equal(await editor.inputValue(),'still pending');
 assert.ok((await page.locator('body').innerText()).includes('Workspace changed.'));
 assert.ok(await page.evaluate(k=>localStorage.getItem(k),draftKey));

 await page.getByRole('button',{name:'Reload / discard draft'}).click();
 await page.getByRole('tab',{name:'App Versions',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'恢复 App v2 到当前工作区',exact:true}).isEnabled(),false);
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'恢复 App v1 到当前工作区',exact:true}).click();
 assert.deepEqual(JSON.parse(await page.getByTestId('restorations').textContent()),[]);
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'恢复 App v1 到当前工作区',exact:true}).click();
 const restores=JSON.parse(await page.getByTestId('restorations').textContent());assert.equal(restores.length,1);assert.equal(restores[0].id,'v1');assert.equal(restores[0].baseRevision,2);assert.ok(restores[0].requestId);
 await page.getByText('恢复已提交，Worker 正在应用并检查；完成后切换到所选版本。',{exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'编辑 src/App.tsx'}).inputValue(),'Blue string');
 assert.equal(await page.getByTestId('submissions').textContent(),'0');
 await page.getByRole('button',{name:'Simulate restored V1'}).click();
 await page.getByRole('tab',{name:'App Versions',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'恢复 App v1 到当前工作区',exact:true}).isEnabled(),false);
 assert.equal(await page.getByRole('button',{name:'恢复 App v2 到当前工作区',exact:true}).isEnabled(),true);
 const ordered=await page.locator('.forge-version-card button:first-child').allTextContents();assert.match(ordered[0],/App v2/);assert.match(ordered[1],/App v1.*Current/);
 await page.getByRole('button',{name:'App v1 · Current · Initial app',exact:true}).click();
 assert.equal(await page.getByRole('textbox',{name:'编辑 src/App.tsx'}).inputValue(),'Original string');
 assert.equal(await page.getByText('Current · Version 1',{exact:false}).count(),1);
 assert.equal(mutations,0);console.log('PASS local product UI: persisted conversation/cards, hidden raw diagnostics, historical readonly source and selection refresh, current editable, saved local draft, add/delete draft, zero remote mutation');
}finally{await browser?.close();await server.close();}
