import {useState} from 'react';
import type {AppVersion,Message,Task} from '@/lib/supabase';
import {stagesOf,parseTaskError} from '@/lib/taskView';
import {pauseTask,resumeTask,retryTask,cancelTask} from '@/lib/data';
export function versionTitle(v:AppVersion){return !v.parent_checkpoint_id?'Initial app':v.label.split('\n')[0].slice(0,80);}
function Progress({task}:{task:Task}) {
 const paths=[...new Set((task.steps||[]).filter(s=>s.event==='finished'&&s.ok&&['write_file','delete_file'].includes(s.tool)).map(s=>s.path).filter(Boolean))];
 for(const step of task.steps||[])if(step.tool==='user_apply'){
  const result=step.result as {files?:Array<{path:string}>}|undefined;
  for(const f of result?.files||[])if(!paths.includes(f.path))paths.push(f.path);
 }
 const busy=task.steps?.findLast(s=>s.event==='retrying');
 return <div className="mt-2 text-xs text-[var(--text-2)] space-y-1" aria-label="工作进度">
 {task.status==='running'&&busy?.phase==='llm_retry'&&<p>模型服务繁忙，正在重试…</p>}
 {stagesOf(task).map(s=><p key={s.key}>{s.label} · {s.status==='done'?'完成':s.status==='running'?'进行中':s.status==='failed'?'未完成':'等待'}</p>)}
 {paths.map(path=><p key={path}>修改 {path}</p>)}
 </div>;
}
export function ConversationTimeline({messages,tasks,versions,currentId,onVersion,onChanged}:{
 messages:Message[];tasks:Task[];versions:AppVersion[];currentId?:string|null;
 onVersion:(id:string)=>void;onChanged:()=>void|Promise<void>;
}) {
 const [error,setError]=useState(''),[pending,setPending]=useState(false);
 const current=tasks[0];
 const control=async(fn:()=>Promise<unknown>)=>{setPending(true);setError('');try{await fn();await onChanged();}catch{setError('操作暂未完成，请稍后重试；项目与代码已保留。');}finally{setPending(false);}};
 const represented=new Set(messages.filter(m=>m.role==='assistant').map(m=>m.task_id).filter(Boolean));
 const lastAssistant=new Map<string, string>();for(const m of messages)if(m.role==='assistant'&&m.task_id)lastAssistant.set(m.task_id,m.id);
 const shown=new Set<string>();
 return <div aria-label="项目对话" className="p-4 space-y-4">
 {messages.map(m=>{
  const task=tasks.find(t=>t.id===m.task_id);
  const checkpoint=typeof m.meta?.checkpointId==='string'?versions.find(v=>v.id===m.meta.checkpointId):undefined;
  let text=m.content;
  if(m.role==='assistant'&&m.meta?.error)text=parseTaskError(task?.error||null)?.reason||'这次操作未完成，项目与代码已保留。';
  else if(checkpoint)text=checkpoint.verify_evidence?.status==='passed'?'应用已生成，可以继续使用和修改。':'应用已生成并可预览；部分自动交互检查尚未验证通过。';
  else if(m.role==='assistant'&&task?.mode==='plan'&&task.status==='succeeded')text='开发计划已生成，请审阅后开始构建。';
  else if(m.role==='assistant'&&/locator\.|bodyText|Traceback|\bat .*file:\/\/|\{"error":/.test(text))text='操作结果已保存；技术细节可在开发者诊断中查看。';
  const card=checkpoint&&!shown.has(checkpoint.id);if(checkpoint)shown.add(checkpoint.id);
  return <article key={m.id} className={m.role==='user'?'rounded-lg bg-[var(--bg)] p-3':'border-l-2 border-[var(--accent)] pl-3'}>
   <p className="text-xs font-medium mb-1">{m.role==='user'?'你':'Forge'}</p>
   <p className="text-sm whitespace-pre-wrap">{text}</p>
   {card&&<button onClick={()=>onVersion(checkpoint!.id)} className="mt-2 p-3 rounded-lg border border-[var(--line)] w-full text-left">
    Version {checkpoint!.version_number} · {versionTitle(checkpoint!)}{checkpoint!.id===currentId?' · Current':''}
   </button>}
   {task&&m.role==='assistant'&&lastAssistant.get(task.id)===m.id&&<Progress task={task}/>}
  </article>;
 })}
 {tasks.filter(t=>!represented.has(t.id)).reverse().map(t=><article key={t.id} className="border-l-2 border-[var(--accent)] pl-3">
  <p className="text-xs font-medium">Forge</p><p className="text-sm">{t.status==='failed'?parseTaskError(t.error)?.reason:t.status==='succeeded'?'本次操作已完成。':'收到，正在处理现有应用…'}</p><Progress task={t}/>
 </article>)}
 {current&&<div className="flex gap-2 text-xs">
  {current.status==='failed'&&<button disabled={pending} onClick={()=>void control(()=>retryTask(current.id,'resume'))}>继续重试</button>}
  {current.status==='running'&&<button disabled={pending} onClick={()=>void control(()=>pauseTask(current.id))}>暂停</button>}
  {current.status==='paused'&&<><button disabled={pending} onClick={()=>void control(()=>resumeTask(current.id))}>继续</button><button disabled={pending} onClick={()=>void control(()=>cancelTask(current.id))}>结束任务</button></>}
 </div>}
 {error&&<p role="alert">{error}</p>}
 </div>;
}
