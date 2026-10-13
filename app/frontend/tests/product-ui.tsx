import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {WorkspaceView} from '../src/components/WorkspaceView';
import type {AppVersion,Message,Project,Task} from '../src/lib/supabase';
const project={id:'p',name:'Product fixture',sandbox_id:'s',checkpoint_id:'v2',preview_url:location.origin+'/tests/stable-app.html',workspace_revision:2,workspace_hash:'hash',workspace_state:'confirmed'} as Project;
const versions=[{id:'v2',project_id:'p',version_number:2,parent_checkpoint_id:'v1',label:'Blue background',workspace_revision:2,code_hash:'hash',verify_evidence:{status:'success_with_warnings'}},
 {id:'v1',project_id:'p',version_number:1,parent_checkpoint_id:null,label:'Initial',workspace_revision:1,code_hash:'old',verify_evidence:{status:'passed'}}] as AppVersion[];
const tasks=[{id:'t2',mode:'build',operation:'user_apply',status:'succeeded',phase:'done_with_warnings',steps:[],plan:[],error:null}] as Task[];
const messages=[{id:'m1',role:'user',content:'把背景改成蓝色',task_id:'t2',meta:{}},
 {id:'m2',role:'assistant',content:'INTERNAL bodyText locator.click',task_id:'t2',meta:{checkpointId:'v2',versionNumber:2}},
 {id:'m0',role:'assistant',content:'Initial app',task_id:'t1',meta:{checkpointId:'v1',versionNumber:1}}] as Message[];
function Demo(){
 const [selected,setSelected]=useState(new URLSearchParams(location.search).get('version'));
 const [submissions,setSubmissions]=useState(0);
 return <><output data-testid="submissions">{submissions}</output><WorkspaceView project={project} files={[{id:'f',project_id:'p',path:'src/App.tsx',content:'Blue string',updated_at:'now'}]}
 messages={messages} tasks={tasks} versions={versions} plans={[]} feedback={[]} error="" memory={null} onBack={()=>{}} onExport={()=>{}} onSubmit={async()=>true} onChanged={()=>{}}
 viewingVersionId={selected} onViewingVersion={id=>{setSelected(id);history.replaceState(null,'',id?'?version='+id:location.pathname);}}
 onApply={async()=>{setSubmissions(n=>n+1);return {accepted:true,noop:true};}}/></>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
