import { useEffect, useRef, useState } from 'react';
import type { ProjectFile, Task } from '@/lib/supabase';
export type ApplyReceipt = {accepted: true; noop: true} | {accepted: true; task_id: string; changeset_id: string; noop?: false};
export type EditSubmission = { requestId: string; baseRevision: number; files: { path: string; content: string }[] };
type Props = {files: ProjectFile[]; readonly?: boolean; revision?: number; blocked?: boolean; task?: Task;
 onApply?: (input: EditSubmission) => Promise<ApplyReceipt>};
/** Drafts stay local. Accepted != applied: actual result comes only from the Worker task. */
export function CodeExplorer({ files, readonly = true, revision = 0, blocked = false, task, onApply }: Props) {
 const [active, setActive] = useState('');
 const [drafts, setDrafts] = useState<Record<string,string>>({});
 const [base, setBase] = useState<number|null>(null);
 const [submitting, setSubmitting] = useState(false);
 const [accepted, setAccepted] = useState('');
 const [error, setError] = useState('');
 const [noop, setNoop] = useState(false);
 const submitted=useRef<Record<string,string>|null>(null);
 const request = useRef<{signature:string; id:string}>();
 const current = files.find(f => f.path === active) ?? files[0];
 const changed = Object.entries(drafts).filter(([path, content]) => content !== files.find(f => f.path === path)?.content);
 const stale = base !== null && base !== revision;
 const result = task?.id === accepted ? task : null;
 useEffect(()=>{
  const applied=submitted.current;
  if(result?.status!=='succeeded' || !applied || !Object.entries(applied).every(([path,content])=>files.find(f=>f.path===path)?.content===content))return;
  const remaining=Object.fromEntries(Object.entries(drafts).filter(([path,content])=>applied[path]!==content));
  setDrafts(remaining);if(!Object.keys(remaining).length)setBase(null);
  submitted.current=null;request.current=undefined;
 },[result?.status,files,drafts]);
 const apply = async () => {
  if (!onApply || readonly || blocked || submitting || stale || !changed.length || base === null) return;
  const input = { baseRevision: base, files: changed.map(([path,content])=>({path,content})).sort((a,b)=>a.path.localeCompare(b.path)) };
  const signature = JSON.stringify(input);
  if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
  setSubmitting(true); setError('');
  try {
   const receipt = await onApply({...input,requestId: request.current.id});
   if (receipt.noop === true) {
    setDrafts({});setBase(null);setAccepted('');setNoop(true);
    submitted.current=null;request.current=undefined;
   } else {
    submitted.current=Object.fromEntries(input.files.map(f=>[f.path,f.content]));
    setAccepted(receipt.task_id);setNoop(false);
   }
  }
  catch(e) { setError(e instanceof Error ? e.message : String(e)); }
  finally { setSubmitting(false); }
 };
 if (!current) return <p className="p-6 text-sm">还没有生成代码。</p>;
 return <div className="h-full flex flex-col min-h-0">
  {!readonly && <div className="p-2 border-b border-[var(--line)] text-xs space-y-1">
   <button className="btn-primary px-3 py-1 rounded" type="button" disabled={blocked || submitting || stale || !changed.length} onClick={() => void apply()}>Apply Changes</button>
   <button className="btn-ghost px-3 py-1" type="button" disabled={submitting} onClick={() => {setDrafts({});setBase(null);setError('');setNoop(false);request.current=undefined;}}>Reload / discard draft</button>
   <span>{changed.length} 个本地修改 · revision {base ?? revision}</span>
   {noop && <p role="status">没有需要应用的更改；未运行构建或验收，也未创建新版本。</p>}
   {submitting && <p role="status">正在提交…</p>}
   {accepted && !result && <p role="status">已接收，等待 Worker；尚未应用。</p>}
   {result && ['queued','running','paused'].includes(result.status) && <p role="status">{result.status === 'paused' ? 'Apply 已暂停，源码和进度保留。' : 'Worker 正在应用并验证；尚未生成 App Version。'}</p>}
   {result?.status === 'succeeded' && <p role="status">修改已应用，构建与验收已得到结论。请在版本面板查看验证状态。</p>}
   {result?.status === 'failed' && <p role="alert">Apply 失败：{result.error}。已确认的源码保留，不会自动调用模型修复。</p>}
   {(error || stale) && <p role="alert" className="text-[var(--danger)]">{stale ? 'Workspace changed. Reload and reapply your edit.' : error}</p>}
   {blocked && <p>有活动任务、恢复或未确认写入时不能 Apply。</p>}
  </div>}
  <div className="flex flex-1 min-h-0">
   <aside className="w-48 shrink-0 border-r border-[var(--line)] overflow-auto">{files.map(f =>
    <button key={f.path} type="button" className="block w-full text-left p-2 font-mono text-xs" onClick={()=>setActive(f.path)}>{f.path}{Object.prototype.hasOwnProperty.call(drafts,f.path) ? ' *' : ''}</button>)}</aside>
   {readonly ? <pre className="flex-1 overflow-auto p-4 text-xs">{current.content}</pre> :
    <textarea aria-label={'编辑 '+current.path} className="flex-1 min-w-0 p-4 font-mono text-xs bg-[var(--panel)] resize-none"
     spellCheck={false} value={drafts[current.path] ?? current.content} disabled={submitting}
     onChange={e=>{ setNoop(false);setBase(b=>b ?? revision);const value=e.target.value;setDrafts(d=>({...d,[current.path]:value}));}}/>}
  </div>
 </div>;
}
