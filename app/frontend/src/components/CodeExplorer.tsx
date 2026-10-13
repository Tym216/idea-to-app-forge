import {useEffect,useRef,useState} from 'react';
import type {ProjectFile,Task} from '@/lib/supabase';
import {parseTaskError} from '@/lib/taskView';
export type ApplyReceipt={accepted:true;noop:true}|{accepted:true;task_id:string;changeset_id:string;noop?:false};
export type EditSubmission={requestId:string;baseRevision:number;files:{path:string;operation?:'write'|'create'|'delete';content?:string}[]};
type Props={files:ProjectFile[];readonly?:boolean;revision?:number;blocked?:boolean;task?:Task;projectId?:string;
 deletablePaths?:string[];onApply?:(input:EditSubmission)=>Promise<ApplyReceipt>};
export function CodeExplorer({files,readonly=true,revision=0,blocked=false,task,projectId,deletablePaths=[],onApply}:Props){
 const key='forge-editor-draft:'+ (import.meta.env.VITE_EXPECTED_SUPABASE_PROJECT_REF||'local')+':'+ (projectId||files[0]?.project_id||'local');
 const [active,setActive]=useState(''),[drafts,setDrafts]=useState<Record<string,string|null>>({});
 const [base,setBase]=useState<number|null>(null),[submitting,setSubmitting]=useState(false),[accepted,setAccepted]=useState('');
 const [error,setError]=useState(''),[noop,setNoop]=useState(false),[saved,setSaved]=useState(false),[newPath,setNewPath]=useState('');
 const submitted=useRef<Record<string,string|null>|null>(null);
 const request=useRef<{signature:string;id:string}>();
 useEffect(()=>{if(readonly)return;try{const data=JSON.parse(localStorage.getItem(key)||'null');
  if(data?.schema===1&&Number.isInteger(data.base)&&data.drafts&&Object.entries(data.drafts).every(([p,v])=>typeof p==='string'&&(typeof v==='string'||v===null))){
   setDrafts(data.drafts);setBase(data.base);setActive(data.active||'');setSaved(true);
  }}catch{/* Bad local drafts never alter server files. */}},[key,readonly]);
 const visible=files.filter(f=>drafts[f.path]!==null).concat(Object.entries(drafts).filter(([p,c])=>c!==null&&!files.some(f=>f.path===p))
  .map(([path,content])=>({id:path,project_id:projectId||'',path,content:content!,updated_at:''})));
 const current=visible.find(f=>f.path===active)||visible[0];
 const changed=Object.entries(drafts).filter(([path,content])=>content===null?files.some(f=>f.path===path):content!==files.find(f=>f.path===path)?.content);
 const stale=base!==null&&base!==revision;
 const result=task?.id===accepted?task:null;
 useEffect(()=>{
  const applied=submitted.current;
  if(result?.status!=='succeeded'||!applied||!Object.entries(applied).every(([p,c])=>c===null?!files.some(f=>f.path===p):files.find(f=>f.path===p)?.content===c))return;
  const remaining=Object.fromEntries(Object.entries(drafts).filter(([p,c])=>applied[p]!==c));
  setDrafts(remaining);setSaved(false);if(!Object.keys(remaining).length){setBase(null);localStorage.removeItem(key);}
  submitted.current=null;request.current=undefined;
 },[result?.status,files,drafts,key]);
 // A completed Apply may finish while this tab is closed. Exact confirmed source
 // equality lets us retire its saved draft without a second mutation or validation.
 useEffect(()=>{
  if(readonly||blocked||base===null||revision<base)return;
  const entries=Object.entries(drafts);
  if(!entries.length||!entries.every(([p,c])=>c===null?!files.some(f=>f.path===p):files.find(f=>f.path===p)?.content===c))return;
  setDrafts({});setBase(null);setSaved(false);localStorage.removeItem(key);
 },[readonly,blocked,base,revision,drafts,files,key]);
 const save=()=>{if(readonly)return;try{localStorage.setItem(key,JSON.stringify({schema:1,base:base??revision,active,drafts}));setSaved(true);}catch{setError('无法保存本地草稿；浏览器存储不可用。');}};
 const change=(path:string,content:string|null)=>{setSaved(false);setNoop(false);setBase(b=>b??revision);setDrafts(d=>({...d,[path]:content}));};
 const add=()=>{const path=newPath.trim().replaceAll('\\','/');
  if(!path||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.forge')||['node_modules','.git','dist'].includes(p))){setError('请输入有效的项目内文件路径。');return;}
  if(visible.some(f=>f.path===path)){setError('文件已存在。');return;}change(path,'');setActive(path);setNewPath('');setError('');
 };
 const remove=()=>{if(!current)return;if(!files.some(f=>f.path===current.path)){
  setDrafts(d=>Object.fromEntries(Object.entries(d).filter(([p])=>p!==current.path)));
 }else change(current.path,null);setActive('');};
 const apply=async()=>{
  if(!onApply||readonly||blocked||submitting||stale||!changed.length||base===null)return;
  const input={baseRevision:base,files:changed.map(([path,content])=>content===null?{path,operation:'delete' as const}:
   {path,operation:(files.some(f=>f.path===path)?'write':'create') as 'write'|'create',content}).sort((a,b)=>a.path.localeCompare(b.path))};
  const signature=JSON.stringify(input);if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()};
  setSubmitting(true);setError('');
  try{const receipt=await onApply({...input,requestId:request.current.id});
   if(receipt.noop){setDrafts({});setBase(null);setAccepted('');setNoop(true);setSaved(false);submitted.current=null;request.current=undefined;localStorage.removeItem(key);}
   else{submitted.current=Object.fromEntries(changed);setAccepted(receipt.task_id);setNoop(false);}
  }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setSubmitting(false);}
 };
 return <div className="h-full flex flex-col min-h-0">
 {!readonly&&<div className="p-2 border-b border-[var(--line)] text-xs space-y-2">
  <div className="flex gap-2 flex-wrap">
   <button className="btn-primary px-3 py-1 rounded" disabled={blocked||submitting||stale||!changed.length} onClick={()=>void apply()}>Apply Changes</button>
   <button className="btn-ghost px-3 py-1" disabled={submitting} onClick={save}>保存草稿</button>
   <button className="btn-ghost px-3 py-1" disabled={submitting} onClick={()=>{setDrafts({});setBase(null);setError('');setNoop(false);setSaved(false);request.current=undefined;localStorage.removeItem(key);}}>Reload / discard draft</button>
   <span>{changed.length} 个本地修改 · revision {base??revision}</span>
  </div>
  <div className="flex gap-2">
   <input aria-label="新文件路径" placeholder="src/new-file.ts" value={newPath} onChange={e=>setNewPath(e.target.value)} className="px-2 py-1 border rounded bg-[var(--panel)]"/>
   <button disabled={blocked||submitting||stale} onClick={add}>Add File</button>
   {current&&(deletablePaths.includes(current.path)||!files.some(f=>f.path===current.path))&&<button disabled={blocked||submitting||stale} onClick={remove}>删除文件</button>}
  </div>
  {saved&&<p role="status">草稿已保存在本浏览器；尚未 Apply。</p>}
  {noop&&<p role="status">没有需要应用的更改；未运行构建或验收，也未创建新版本。</p>}
  {submitting&&<p role="status">正在提交…</p>}
  {accepted&&!result&&<p role="status">已接收，等待 Worker；尚未应用。</p>}
  {result&&['queued','running','paused'].includes(result.status)&&<p role="status">{result.status==='paused'?'Apply 已暂停，源码和进度保留。':'Worker 正在应用并验证；尚未生成 App Version。'}</p>}
  {result?.status==='succeeded'&&<p role="status">修改已应用，构建与验收已得到结论。请在版本面板查看验证状态。</p>}
  {result?.status==='failed'&&<p role="alert">Apply 未完成：{parseTaskError(result.error)?.reason}。已确认的源码保留，不会自动调用模型修复。</p>}
  {(error||stale)&&<p role="alert">{stale?'Workspace changed. Reload and reapply your edit.':error}</p>}
  {blocked&&<p>正在确认工作区状态，或当前任务尚未结束。代码与草稿已保留。</p>}
 </div>}
 <div className="flex flex-1 min-h-0">
  <aside className="w-48 shrink-0 border-r overflow-auto">{visible.map(f=><button key={f.path} className="block w-full text-left p-2 font-mono text-xs" onClick={()=>setActive(f.path)}>{f.path}{Object.hasOwn(drafts,f.path)?' *':''}</button>)}</aside>
  {!current?<p className="p-4">还没有文件。可以添加本地文件草稿。</p>:readonly?<pre className="flex-1 overflow-auto p-4 text-xs">{current.content}</pre>:
   <textarea aria-label={'编辑 '+current.path} className="flex-1 min-w-0 p-4 font-mono text-xs bg-[var(--panel)] resize-none" spellCheck={false}
    value={drafts[current.path]??current.content} disabled={submitting} onChange={e=>change(current.path,e.target.value)}
    onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();save();}}}/>}
 </div></div>;
}
