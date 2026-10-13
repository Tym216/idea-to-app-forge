import {useEffect,useRef,useState} from 'react';
import {requestPreviewOnce} from './workspaceState';

/** A GET observes the saved public origin; it never resolves a new Daytona URL. */
export async function probePreviewHealth(url:string):Promise<boolean|null> {
 try {
  const response=await fetch(url,{method:'GET',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(6000)});
  return response.ok;
 } catch {return null;}
}

/** Mount/refresh is a read, not a request to recover. Pending jobs are only observed. */
export function usePreviewEntry({identity,url,pending,canRecover,recover,probe=probePreviewHealth}:{
 identity:string|null;url:string|null;pending:boolean;canRecover:boolean;
 recover:()=>Promise<void>;probe?:(url:string)=>Promise<boolean|null>;
}) {
 const checks=useRef(new Map<string,Promise<boolean|null>>());
 const attempts=useRef(new Set<string>());
 const [health,setHealth]=useState<{identity:string;healthy:boolean|null}|null>(null);
 useEffect(()=>{
  if(!identity||pending)return;
  let active=true;
  let check=checks.current.get(identity);
  if(!check){check=url?probe(url):Promise.resolve(false);checks.current.set(identity,check);}
  void check.then(healthy=>{
   if(!active)return;
   setHealth({identity,healthy});
   if(healthy===false&&canRecover)void requestPreviewOnce(identity,attempts.current,recover);
  });
  return ()=>{active=false;};
 },[identity,url,pending,canRecover,recover,probe]);
 return health?.identity===identity?health.healthy:null;
}
