
import {useEffect,useState} from 'react';
import {useParams,Link} from 'react-router-dom';
import {useSession} from '@/hooks/useSession';
import {getProject,getPreviewRecovery,requestPreviewRecovery} from '@/lib/data';
import type {Project,PreviewRecovery} from '@/lib/supabase';
import {PreviewPane} from '@/components/PreviewPane';
import {usePreviewEntry} from '@/lib/previewEntry';
/** Stable, authenticated Forge host for standalone generated-App previews. */
export default function AppPreview(){
 const {projectId=''}=useParams();const {session,loading}=useSession();
 const [project,setProject]=useState<Project|null>(null),[job,setJob]=useState<PreviewRecovery|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  if(!session)return;let active=true;
  const read=async()=>{try{const [p,j]=await Promise.all([getProject(projectId),getPreviewRecovery(projectId)]);
   if(p.user_id!==session.user.id)throw Error('项目不属于当前账号');if(active){setProject(p);setJob(j);}
  }catch(e){if(active)setError(e instanceof Error?e.message:String(e));}};
  void read();const timer=setInterval(()=>void read(),4000);return()=>{active=false;clearInterval(timer);};
 },[projectId,session?.user.id]);
 const recover=async()=>{try{setJob(await requestPreviewRecovery(projectId));}catch(e){setError(String(e));}};
 const identity=project?[project.id,project.sandbox_id,project.preview_url].join(':'):null;
 const health=usePreviewEntry({identity,url:project?.preview_url??null,pending:['queued','running'].includes(job?.status??''),
 canRecover:project?.workspace_state==='confirmed'&&!project.workspace_writer,recover});
 if(loading)return <p>正在确认登录…</p>;
 if(!session)return <div className="p-6">请先<Link className="forge-btn forge-btn-primary ml-2" to="/">登录 Forge</Link>，再打开此预览。</div>;
 return <main className="h-screen flex flex-col">
  <header className="p-2 border-b flex items-center gap-3"><Link className="forge-btn forge-btn-neutral" to={'/workspace/'+projectId}>返回项目</Link><span>{project?.name}</span></header>
  {error&&<p role="alert">{error}</p>}
  <div className="flex-1 min-h-0"><PreviewPane url={health===false?null:project?.preview_url??null} recovery={job} onRecover={()=>void recover()}
   storageIdentity={project&&project.user_id===session.user.id?{environment:import.meta.env.VITE_FORGE_ENVIRONMENT_ID,
    ref:import.meta.env.VITE_EXPECTED_SUPABASE_PROJECT_REF,userId:session.user.id,projectId}:undefined}/></div>
 </main>;
}
