import React, {useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {CodeExplorer} from '../src/components/CodeExplorer';
import {VersionsPanel} from '../src/components/VersionsPanel';
import {TaskPanel} from '../src/components/TaskPanel';
import {PreviewPane} from '../src/components/PreviewPane';
import {defaultMode,stableWorkspace,readyPreview,previewRecoveryKey,requestPreviewOnce} from '../src/lib/workspaceState';
import type {AppVersion,Project,Task} from '../src/lib/supabase';
const file={id:'f',project_id:'p',path:'src/App.tsx',content:'original',updated_at:'now'};
const version={id:'v1',project_id:'p',version_number:1,parent_checkpoint_id:null,label:'Initial',workspace_revision:1,code_hash:'hash',basis_id:'b',created_at:'now',verify_evidence:{status:'inconclusive'},files:[{path:file.path,content:'historical'}]} as AppVersion;
const project={id:'p',sandbox_id:'s',checkpoint_id:'v1',workspace_revision:1,workspace_hash:'hash',workspace_state:'confirmed'} as Project;
function RecoveryProbe() {
 const [failure,setFailure]=useState(false);
 const attempted=useRef(new Set<string>());const [poll,setPoll]=useState(0);const [requests,setRequests]=useState(0);
 useEffect(()=>{requestPreviewOnce(previewRecoveryKey(project,[],true),attempted.current,async()=>{setRequests(n=>n+1);});},[poll]);
 const task={id:'warn',mode:'build',status:'succeeded',phase:'done_with_warnings',steps:[{tool:'verify_report',at:'2026-10-13T00:00:00Z',observation:'验收报告已保存',
 result:{kind:'success_with_warnings',items:[{id:'A1',status:'warning',reason:'locator.click: Timeout',
 stepResults:[{observed:{bodyText:'INTERNAL_BODY_DUMP'}}]}]}}]} as unknown as Task;
 const displayed=failure?{...task,status:'failed',phase:'error',error:JSON.stringify({code:'VERIFY_FAILED',reason:'浏览器验收未通过',next:'old generic retry'}),steps:[
 {tool:'verify_attempt',at:'now',observation:'HTTP check',event:'started',result:{mode:'http'}},
 {tool:'logic_check',at:'now',observation:'Logic evidence saved',result:{status:'failed',tests:10,passed:8,failed:2,details:'TEST_ASSERT expected: true actual: false'}},
 {tool:'verify_report',at:'now',observation:'Report saved',result:{kind:'blocker',items:[{id:'A1',status:'inconclusive',reason:'浏览器交互未执行'}]}}
 ]} as unknown as Task:task;
 return <section data-testid="recovery-probe"><button onClick={()=>setFailure(true)}>Show logic failure</button>
 <button onClick={()=>setPoll(n=>n+1)}>Poll preview</button><output data-testid="recovery-requests">{requests}</output>
 <PreviewPane url={null} recovery={{status:'queued'} as never} recoveryError="fetch failed"/>
 <TaskPanel current={displayed} history={[]} onChanged={()=>{}}/>
 </section>;
}
function Demo() {
 const [revision,setRevision]=useState(1);const [blocked,setBlocked]=useState(false);const [submissions,setSubmissions]=useState(0);
 const [noOp,setNoOp]=useState(false);
 const [currentFiles,setCurrentFiles]=useState([file]);
 const [task,setTask]=useState<Task|undefined>();const [reject,setReject]=useState(false);
 return <div><RecoveryProbe/><button onClick={()=>setNoOp(true)}>Return no-op</button><button onClick={()=>setRevision(r=>r+1)}>Change revision</button><button onClick={()=>setBlocked(b=>!b)}>Toggle active</button>
 <button onClick={()=>setReject(true)}>Reject stale</button><button onClick={()=>{setTask(t=>t ? {...t,status:'succeeded'}:undefined);setCurrentFiles([{...file,content:'edited'}]);setRevision(2);}}>Complete</button>
 <output data-testid="submissions">{submissions}</output><output data-testid="default-mode">{defaultMode(project)}</output>
 <output data-testid="stable">{String(stableWorkspace({...project,workspace_revision:revision},version))}</output>
 <output data-testid="old-preview">{String(readyPreview(project,{project_id:'p',sandbox_id:'s',status:'ready',ready_revision:0,ready_hash:'old'} as never))}</output>
 <div data-testid="code-probe" style={{height:320}}><CodeExplorer files={currentFiles} revision={revision} blocked={blocked} readonly={false} task={task} onApply={async input=>{
   setSubmissions(n=>n+1);if(reject)throw Error('Workspace changed. Reload and reapply your edit.');
   if(input.baseRevision!==revision)throw Error('stale');if(noOp)return {accepted:true,noop:true};setTask({id:'edit',status:'queued'} as Task);return {accepted:true,task_id:'edit',changeset_id:'change'};
 }}/></div>
 <VersionsPanel versions={[version]} currentId="v1" workingDraft={revision!==1} load={async()=>version}/>
 <div style={{height:100}}><PreviewPane url={null} recoveryPending label="Working Workspace"/></div>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
