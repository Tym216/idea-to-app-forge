import {useEffect,useRef,useState} from 'react';
import {requestPreviewOnce} from './workspaceState';

/** A GET observes the saved public origin; it never resolves a new Daytona URL. */
export async function probePreviewHealth(url:string):Promise<boolean|null> {
 try {
  const response=await fetch(url,{method:'GET',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(6000)});
  return response.ok;
 } catch {return null;}
}

const HEALTH_TTL_MS=30000;
const UNKNOWN_LIMIT=3;
/** Re-entry checks liveness; only failed checks enqueue the existing, fenced recovery flow.
 * Unknown browser reads are retried twice before requesting a server-side check. A warm
 * iframe is never remounted by metadata polling, focus, or a successful health check.
 */
export function usePreviewEntry({identity,url,pending,canRecover,recover,probe=probePreviewHealth}:{
 identity:string|null;url:string|null;pending:boolean;canRecover:boolean;
 recover:()=>Promise<void>;probe?:(url:string)=>Promise<boolean|null>;
}) {
 const check=useRef<{identity:string;at:number;promise:Promise<boolean|null>;unknownCounted?:boolean}|null>(null);
 const attempts=useRef(new Set<string>());
 const unknown=useRef({identity:'',count:0});
 const previousPending=useRef(pending);
 const callbacks=useRef({recover,probe});callbacks.current={recover,probe};
 const [tick,setTick]=useState(0);
 const [health,setHealth]=useState<{identity:string;healthy:boolean|null}|null>(null);
 useEffect(()=>{
  const recheck=()=>{
   if(document.visibilityState==='hidden')return;
   check.current=null;setTick(n=>n+1);
  };
  const visible=()=>{if(document.visibilityState==='visible')recheck();};
  window.addEventListener('focus',recheck);
  window.addEventListener('online',recheck);
  window.addEventListener('pageshow',recheck);
  document.addEventListener('visibilitychange',visible);
  const timer=setInterval(recheck,HEALTH_TTL_MS);
  return()=>{
   clearInterval(timer);window.removeEventListener('focus',recheck);
   window.removeEventListener('online',recheck);window.removeEventListener('pageshow',recheck);
   document.removeEventListener('visibilitychange',visible);
  };
 },[]);
 useEffect(()=>{
  if(!identity)return;
  // Recovery may reuse exactly the same URL. Re-read it after the job ends.
  if(previousPending.current&&!pending)check.current=null;
  previousPending.current=pending;
  if(unknown.current.identity!==identity)unknown.current={identity,count:0};
  let active=true;let retry:ReturnType<typeof setTimeout>|undefined;
  let read=check.current;
  if(!read||read.identity!==identity||Date.now()-read.at>=HEALTH_TTL_MS){
   read={identity,at:Date.now(),promise:url?Promise.resolve().then(()=>callbacks.current.probe(url)).catch(()=>null):Promise.resolve(false)};
   check.current=read;
  }
  const currentRead=read;
  void read.promise.then(healthy=>{
   if(!active)return;
   // Count observations, not React rerenders that reuse an in-flight promise.
   if(healthy===true){unknown.current.count=0;attempts.current.delete(identity);}
   if(healthy===null&&navigator.onLine&&!pending){
    if(!currentRead.unknownCounted){unknown.current.count++;currentRead.unknownCounted=true;}
    if(unknown.current.count<UNKNOWN_LIMIT){
     retry=setTimeout(()=>{if(check.current===currentRead)check.current=null;setTick(n=>n+1);},2000*unknown.current.count);
    }
   }
   const failed=healthy===false||(healthy===null&&navigator.onLine&&unknown.current.count>=UNKNOWN_LIMIT);
   setHealth({identity,healthy:failed?false:healthy});
   if(failed&&!pending&&canRecover)void requestPreviewOnce(identity,attempts.current,()=>callbacks.current.recover());
  });
  return ()=>{active=false;if(retry)clearTimeout(retry);};
 },[identity,url,pending,canRecover,tick]);
 return health?.identity===identity?health.healthy:null;
}
