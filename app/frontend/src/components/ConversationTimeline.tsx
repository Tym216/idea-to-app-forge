import {useState} from 'react';
import type {AppVersion,Message,Plan,Task} from '@/lib/supabase';
import {pauseTask,resumeTask,retryTask,cancelTask} from '@/lib/data';
import {conversationTurns,changedPaths,turnResponse,versionTitle} from '@/lib/conversation';
export {versionTitle} from '@/lib/conversation';
function Details({task,version}:{task?:Task;version?:AppVersion}){
 if(!task)return null;const paths=changedPaths(task),done=task.status==='succeeded';
 const build=task.steps?.findLast(s=>s.tool==='build'&&s.event==='finished');
 const preview=task.steps?.findLast(s=>s.tool==='start_dev'&&s.event==='finished');
 const fast=version?.verify_evidence?.result?.validationMode==='health';
 const httpOnly=version?.verify_evidence?.result?.validationMode==='http';
 return <details aria-label="执行详情" className="mt-2 text-xs text-[var(--text-2)]">
  <summary className="cursor-pointer">{done?'✓ 完成':'执行详情'}{paths.length?' · 修改 '+paths.length+' 个文件':''}{done?httpOnly?' · 服务检查完成，功能未验收':fast?' · 基础检查通过':' · 检查已有结论':''}</summary>
  <ul className="mt-2 space-y-1">
   {paths.map(p=><li key={p}>修改 {p}</li>)}
   {build&&<li>{build.ok?'构建检查通过':'构建检查未通过'}</li>}
   {preview&&<li>{preview.ok?'Preview 已更新':'Preview 尚未就绪'}</li>}
   {version&&<li>{httpOnly?'仅验证构建和 HTTP；页面渲染、runtime 与功能交互未检查':fast?'仅验证 HTTP、实际渲染与 runtime；未运行功能交互验收':version.verify_evidence?.status==='passed'?'功能检查通过':'部分自动功能检查尚未确认'}</li>}
  </ul>
 </details>;
}
export function ConversationTimeline({messages,tasks,versions,plans=[],currentId,onVersion,onChanged}:{
 messages:Message[];tasks:Task[];versions:AppVersion[];plans?:Plan[];currentId?:string|null;
 onVersion:(id:string)=>void;onChanged:()=>void|Promise<void>;
}){
 const [error,setError]=useState(''),[pending,setPending]=useState(false);
 const control=async(fn:()=>Promise<unknown>)=>{setPending(true);setError('');try{await fn();await onChanged();}catch{setError('操作暂未完成，请稍后重试；项目与代码已保留。');}finally{setPending(false);}};
 return <div aria-label="项目对话" className="p-4 space-y-6">
  {conversationTurns(messages,tasks,versions,plans).map(turn=>{
   const task=turn.tasks[0],version=turn.versions.at(-1);
   return <section key={turn.id} data-conversation-turn={turn.id} className="space-y-3">
    {turn.user&&<article className="rounded-lg bg-[var(--bg)] p-3"><p className="text-xs font-medium mb-1">你</p><p className="text-sm whitespace-pre-wrap">{turn.user.content}</p></article>}
    <article data-forge-turn={turn.id} className="pl-1">
     <p className="text-xs font-medium mb-2">Forge</p><p className="text-sm whitespace-pre-wrap">{turnResponse(turn)}</p>
     {turn.versions.map(v=><button key={v.id} onClick={()=>onVersion(v.id)} className="mt-3 p-3 rounded-lg border border-[var(--line)] w-full text-left text-sm">
      Version {v.version_number} · {versionTitle(v,turn.intent)}{v.id===currentId?' · Current':''}
     </button>)}
     <Details task={task} version={version}/>
     {task?.id===tasks[0]?.id&&<div className="mt-2 flex gap-2 text-xs">
      {task.status==='failed'&&<button disabled={pending} onClick={()=>void control(()=>retryTask(task.id,'resume'))}>继续重试</button>}
      {task.status==='running'&&<button disabled={pending} onClick={()=>void control(()=>pauseTask(task.id))}>暂停</button>}
      {task.status==='paused'&&<><button disabled={pending} onClick={()=>void control(()=>resumeTask(task.id))}>继续</button><button disabled={pending} onClick={()=>void control(()=>cancelTask(task.id))}>结束任务</button></>}
     </div>}
    </article>
   </section>;
  })}
  {error&&<p role="alert">{error}</p>}
 </div>;
}
