import {useEffect} from 'react';
import {useSession} from './useSession';
import {listProjects,requestPreviewRecovery} from '@/lib/data';
import {probePreviewHealth} from '@/lib/previewEntry';
import {createAccountPreviewWarmup} from '@/lib/accountPreviewWarmup';

/** Logged-in, visible Forge only. Logout/hidden/offline cancels future wake submissions;
 * an already accepted atomic recovery is allowed to finish and normal idle stop applies.
 */
export function useAccountPreviewWarmup(){
 const {session}=useSession();const userId=session?.user.id;
 useEffect(()=>{
  if(!userId)return;
  const warmup=createAccountPreviewWarmup({userId,listProjects,probe:probePreviewHealth,
   recover:requestPreviewRecovery,isActive:()=>document.visibilityState==='visible'&&navigator.onLine});
  const check=()=>{void warmup.check().catch(()=>undefined);};
  check();
  const timer=setInterval(check,300000);
  window.addEventListener('focus',check);window.addEventListener('online',check);
  document.addEventListener('visibilitychange',check);
  return()=>{warmup.stop();clearInterval(timer);window.removeEventListener('focus',check);
   window.removeEventListener('online',check);document.removeEventListener('visibilitychange',check);};
 },[userId]);
}
