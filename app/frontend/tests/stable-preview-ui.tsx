import React,{useState,useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import {usePreviewEntry,probePreviewHealth} from '../src/lib/previewEntry';
import {previewRecoveryKey,savedPreviewIdentity} from '../src/lib/workspaceState';
import {PreviewPane} from '../src/components/PreviewPane';
import type {Project} from '../src/lib/supabase';
const unknownProbe=async()=>null;
function Preview({mode,signal}:{mode:string;signal:number}) {
 const url=location.origin+(mode==='broken'?'/tests/unavailable-preview':'/tests/stable-app.html');
 const project={id:'p',sandbox_id:'s',preview_url:url,workspace_revision:6,workspace_hash:'hash',workspace_state:mode==='uncertain'?'uncertain':'confirmed',
 workspace_writer:mode==='uncertain'?{kind:'preview',sandbox_id:'s',base_revision:6,base_hash:'hash'}:null} as Project;
 const [pending,setPending]=useState(mode==='pending');
 const recover=useCallback(async()=>{
  localStorage.setItem('test-recovery-posts',String(Number(localStorage.getItem('test-recovery-posts')||0)+1));
  setPending(true);
 },[]);
 const identity=savedPreviewIdentity(project,[],true);
 const health=usePreviewEntry({identity,url,pending,canRecover:previewRecoveryKey(project,[],true)!==null,recover,
 probe:mode==='unknown'?unknownProbe:probePreviewHealth});
 return <section data-signal={signal}><output data-testid="health">{String(health)}</output>
 <output data-testid="identity">{identity}</output>
 <PreviewPane url={identity&&health!==false?url:null} recoveryPending={pending}
 recovery={mode==='uncertain'?{status:'failed',error:'previous preview network failure'} as never:{status:'ready',execution_id:'same',updated_at:String(signal)} as never}/>
 </section>;
}
function Demo() {
 const [visible,setVisible]=useState(true);const [signal,setSignal]=useState(0);const [mode,setMode]=useState('warm');
 return <div><button onClick={()=>setVisible(v=>!v)}>Away/back</button>
 <button onClick={()=>setSignal(n=>n+1)}>Poll</button>
 {['warm','broken','pending','unknown','uncertain'].map(value=><button key={value} onClick={()=>setMode(value)}>{value}</button>)}
 {visible&&<Preview key={mode} mode={mode} signal={signal}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Demo/></React.StrictMode>);
