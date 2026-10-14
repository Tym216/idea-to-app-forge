
import {useEffect,useState,type RefObject} from 'react';
import {attachPreviewStorage,type StorageIdentity} from '../../../shared/preview-storage.js';
export type PreviewStorageIdentity=StorageIdentity;
export function usePreviewStorage(frame:RefObject<HTMLIFrameElement>,url:string|null,identity?:PreviewStorageIdentity,nonce=0) {
 const [status,setStatus]=useState('');
 useEffect(()=>{
  setStatus('');
  if(!frame.current||!url||!identity)return;
  const origin=new URL(url).origin;
  let seen=false;
  const dispose=attachPreviewStorage({frame:frame.current,origin,identity,onStatus:s=>{seen=true;setStatus(s);}});
  const timer=setTimeout(()=>{if(!seen)setStatus('unavailable');},8500);
  return()=>{clearTimeout(timer);dispose();};
 },[frame,url,identity?.environment,identity?.ref,identity?.userId,identity?.projectId,nonce]);
 return status;
}
