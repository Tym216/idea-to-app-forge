import { useRef, useState } from 'react';
import type { AppVersion, ProjectFile } from '@/lib/supabase';
import { getAppVersion } from '@/lib/data';
import { CodeExplorer } from './CodeExplorer';
export function VersionsPanel({versions,currentId,workingDraft,load=getAppVersion}:{
 versions:AppVersion[];currentId?:string|null;workingDraft:boolean;load?:typeof getAppVersion}) {
 const [selected,setSelected]=useState<AppVersion|null>(null);
 const [error,setError]=useState('');const [loading,setLoading]=useState(false);
 const request=useRef(0);
 const pick=async(id:string)=>{const n=++request.current;setLoading(true);setError('');try{const version=await load(id);if(n===request.current)setSelected(version);}catch(e){if(n===request.current)setError(String(e));}finally{if(n===request.current)setLoading(false);}};
 const files: ProjectFile[]=(selected?.files ?? []).map(f=>({...f,id:f.path,project_id:selected!.project_id,updated_at:selected!.created_at}));
 return <div className="h-full flex flex-col min-h-0">
  <div className="p-3 text-sm">{workingDraft && <p>工作区正在处理或含未发布修改。预览展示 Working Workspace，不代表 Current App Version。</p>}
   {versions.length===0 && <p>还没有编号的 App Version。历史 legacy checkpoint 不会被伪造为 v0。</p>}
   {versions.map(v=><button className="btn-ghost px-3 py-2" key={v.id} onClick={()=>void pick(v.id)}>
    App v{v.version_number}{v.id===currentId ? ' · Current' : ''} · {v.label}</button>)}
   {loading && <p role="status">读取版本源码…</p>}{error && <p role="alert">{error}</p>}
   {selected && <p>App v{selected.version_number} · revision {selected.workspace_revision} · 验收：{selected.verify_evidence?.status ?? '未验证'} · 历史源码只读。Code Version 不回滚业务数据。</p>}
  </div>
  {selected && <div className="flex-1 min-h-0"><CodeExplorer key={selected.id} files={files} readonly/></div>}
 </div>;
}
