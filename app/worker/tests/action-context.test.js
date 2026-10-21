import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildActionContext} from '../src/action-context.js';
test('action brief uses bounded deterministic source index; full source/user requirement remain unchanged',()=>{
 const task={prompt:'保留现有计分，增加暂停功能'},project={name:'Game',description:'已有计分游戏'};
 const files=[{path:'src/App.tsx',content:'export function App(){ return <button data-testid="pause">暂停</button>; }'+ ' /* body */'.repeat(5000)}];
 const before=structuredClone(files),view=buildActionContext({task,project,files,memoryText:'偏好绿色',instructions:['generic instruction']});
 assert.deepEqual(files,before);assert.ok(view.text.length<1500);assert.ok(view.sourceChars>50000);
 for(const text of ['src/App.tsx','pause','App',task.prompt,project.description,'偏好绿色','generic instruction'])assert.ok(view.text.includes(text));
 assert.ok(!view.text.includes('/* body */'));assert.match(view.text,/不是完整源码/);
 assert.equal(view.parts.initial_code,view.indexChars);
});
test('large file inventory omissions are explicit and deterministic; never pretend it is a complete manifest',()=>{
 const files=Array.from({length:2000},(_,i)=>({path:'src/f'+String(i).padStart(4,'0')+'.ts',content:'export const x=1;'}));
 const args={task:{prompt:'改文案'},project:{name:'x'},files};const view=buildActionContext(args);
 assert.ok(view.indexChars<6200);assert.match(view.text,/未列入本次规划视图/);
 assert.equal(view.text,buildActionContext({...args,files:[...files].reverse()}).text);
});
