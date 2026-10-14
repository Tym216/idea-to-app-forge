import {conversationTurns,turnResponse,versionTitle} from '../src/lib/conversation';
import '../src/index.css';
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
const transient=[{...messages[1],id:'progress',content:'WORKSPACE_UNCERTAIN manifest dump'},...messages];
const persisted=conversationTurns(transient,tasks,versions);
const running=conversationTurns(transient,[{...tasks[0],status:'running',phase:'write_file'}],versions);
const checking=conversationTurns(transient,[{...tasks[0],status:'running',phase:'verify'}],versions);
const rootTask={...tasks[0],id:'plan',mode:'plan',plan_id:'initial',prompt:'Build Todo'} as Task;
const buildTask={...tasks[0],id:'build',plan_id:'initial'} as Task;
const firstRequest={...messages[0],task_id:null,content:'Build Todo'};
const initial=conversationTurns([firstRequest],[buildTask,rootTask],[],[{id:'initial',source_task_id:'plan'} as never]);
const projectionProof={turns:persisted.length,oneTaskAssistant:persisted.filter(t=>t.tasks.some(x=>x.id==='t2')).length,
 stableTurnId:running[0].id===checking[0].id,progressChanged:turnResponse(running[0])!==turnResponse(checking[0]),
 noRaw:!turnResponse(persisted[0]).includes('WORKSPACE'),intentTitle:versionTitle(versions[0],persisted[0].intent),initialOneTurn:initial.length===1&&initial[0].tasks.length===2};
function Demo(){
 const [restored,setRestored]=useState(false);
 const [selected,setSelected]=useState(new URLSearchParams(location.search).get('version'));
 const [submissions,setSubmissions]=useState(0);
 const [restorations,setRestorations]=useState<unknown[]>([]);
 const liveProject=restored?{...project,checkpoint_id:'technical-restore',active_app_version_id:'v1',workspace_revision:3,workspace_hash:'old'}:project;
 const technical=restored?{...versions[1],id:'technical-restore',app_version_id:'v1',workspace_revision:3}:undefined;
 return <><button onClick={()=>{setRestored(true);setSelected(null);history.replaceState(null,'',location.pathname);}}>Simulate restored V1</button><output hidden data-testid="restorations">{JSON.stringify(restorations)}</output><output hidden data-testid="projection-proof">{JSON.stringify(projectionProof)}</output><output data-testid="submissions">{submissions}</output><WorkspaceView project={liveProject} checkpoint={technical} files={[{id:'f',project_id:'p',path:'src/App.tsx',content:restored?'Original string':'Blue string',updated_at:'now'}]}
 messages={messages} tasks={tasks} versions={versions} plans={[]} feedback={[]} error="" memory={null} onBack={()=>{}} onExport={()=>{}} onSubmit={async()=>true} onChanged={()=>{}}
 viewingVersionId={selected} onViewingVersion={id=>{setSelected(id);history.replaceState(null,'',id?'?version='+id:location.pathname);}}
 onRestore={async(id,requestId,baseRevision)=>{setRestorations(r=>[...r,{id,requestId,baseRevision}]);return {accepted:true,task_id:'restore-task',changeset_id:'restore-change'};}}
 onApply={async()=>{setSubmissions(n=>n+1);return {accepted:true,noop:true};}}/></>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
