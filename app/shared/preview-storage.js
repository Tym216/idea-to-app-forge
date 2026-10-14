
/** Only the trusted Forge host chooses a namespace. Child messages cannot select users/projects. */
export const STORAGE_PROTOCOL = 'forge-preview-storage-v1';
const MAX_BYTES = 4 * 1024 * 1024;
export function appStorageKey({environment,ref,userId,projectId}) {
 if (![environment,ref,userId,projectId].every(v=>typeof v==='string'&&v.length)) throw Error('APP_STORAGE_IDENTITY');
 return ['forge-app-data-v1',environment,ref,userId,projectId].map(encodeURIComponent).join(':');
}
function record(storage,key) {
 const raw=storage.getItem(key);
 if(raw===null)return null;
 const data=JSON.parse(raw);
 if(data?.schema!==1||!Number.isSafeInteger(data.revision)||data.revision<0||!validEntries(data.entries))throw Error('APP_STORAGE_CORRUPT: original data retained');
 return data;
}
function validEntries(entries) {
 return entries&&typeof entries==='object'&&!Array.isArray(entries)&&Object.entries(entries).every(([k,v])=>typeof v==='string'&&k.length<=2000);
}
export function attachPreviewStorage({frame,origin,identity,storage=localStorage,host=window,locks=navigator.locks,onStatus=()=>{}}) {
 const key=appStorageKey(identity);
 let channel=null,session=null,active=true;
 const send=(data)=>{if(active)frame.contentWindow?.postMessage({protocol:STORAGE_PROTOCOL,channel,session,...data},origin);};
 const listener=async(event)=>{
  if(!active||event.source!==frame.contentWindow||event.origin!==origin||event.data?.protocol!==STORAGE_PROTOCOL)return;
  const m=event.data;
  if(typeof m.channel!=='string'||m.channel.length<16||m.channel.length>100)return;
  if(m.op!=='hello'&&(m.channel!==channel||m.session!==session))return;
  try {
   if(!locks?.request)throw Error('APP_STORAGE_UNAVAILABLE: browser locks required');
   await locks.request(key,()=>{
    if(!active)return;
    if(m.op==='hello'&&(channel!==m.channel||!session)){channel=m.channel;session=crypto.randomUUID();}
    if(m.op!=='hello'&&(m.channel!==channel||m.session!==session))return;
    const current=record(storage,key);
    if(m.op==='hello'){
     if(!current){
      if(!validEntries(m.legacy)||JSON.stringify(m.legacy).length>MAX_BYTES)throw Error('APP_STORAGE_LEGACY_INVALID');
      const migrated={schema:1,revision:0,entries:m.legacy};
      storage.setItem(key,JSON.stringify(migrated));
      send({op:'ready',...migrated});
     } else send({op:'ready',...current});
     onStatus('ready');return;
    }
    if(m.op!=='write'||!Number.isSafeInteger(m.seq)||!current)return;
    if(m.revision!==current.revision)throw Error('APP_STORAGE_CONFLICT: another preview changed data; reload');
    if(!validEntries(m.entries)||JSON.stringify(m.entries).length>MAX_BYTES)throw Error('APP_STORAGE_LIMIT');
    const next={schema:1,revision:current.revision+1,entries:m.entries};
    storage.setItem(key,JSON.stringify(next));send({op:'saved',seq:m.seq,revision:next.revision});onStatus('saved');
   });
  } catch(e){send({op:'error',seq:m.seq,error:String(e.message||e)});onStatus('error');}
 };
 host.addEventListener('message',listener);
 return ()=>{active=false;host.removeEventListener('message',listener);};
}
export async function resetPreviewStorage(identity,{storage=localStorage,locks=navigator.locks}={}) {
 const key=appStorageKey(identity);
 if(!locks?.request)throw Error('APP_STORAGE_UNAVAILABLE');
 return locks.request(key,()=>{
  let current=null;try{current=record(storage,key);}catch{/* Explicit confirmed reset may replace malformed data. */}
  storage.setItem(key,JSON.stringify({schema:1,revision:(current?.revision??0)+1,entries:{}}));
 });
}
/** Runs before any generated App module; supported Apps use localStorage or the provided SDK. */
export async function previewBootstrap(options,modules) {
 const protocol='forge-preview-storage-v1';
 const launch=async()=>{for(const m of modules){if(m.src)await import(/* @vite-ignore */ new URL(m.src,document.baseURI).href);else await import(/* @vite-ignore */ URL.createObjectURL(new Blob([m.code],{type:'text/javascript'})));}};
 // Local verifier/health runtime is isolated from real user business data.
 if(['127.0.0.1','localhost','[::1]'].includes(location.hostname)&&options.allowLocalValidation){await launch();return;}
 if(window.parent===window){location.replace(options.hostOrigin+'/preview/'+encodeURIComponent(options.projectId));return;}
 const parentOrigin=new URL(document.referrer||options.hostOrigin).origin;
 if(parentOrigin!==options.hostOrigin)throw Error('APP_STORAGE_HOST_MISMATCH');
 const channel=crypto.randomUUID();
 let entries=Object.create(null),revision=0,session=null,seq=0,blocked=false;
 let pending=null,dirty=false;
 const fail=(message)=>{
  blocked=true;window.__forgeStorageStatus={status:'blocked',error:message};
  const panel=document.createElement('div');panel.setAttribute('role','alert');
  panel.style.cssText='position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;padding:12px;background:#fff1f2;color:#9f1239;border:1px solid #fecdd3;border-radius:8px';
  panel.textContent='应用数据未能安全保存：'+message+'。原数据保留，请重新打开预览。';
  document.body.append(panel);
 };
 const post=data=>window.parent.postMessage({protocol,channel,session,...data},options.hostOrigin);
 const flush=()=>{
  if(blocked||pending||!dirty)return;
  dirty=false;const n=++seq;
  pending={seq:n,timer:setTimeout(()=>fail('保存确认超时'),8000)};
  post({op:'write',seq:n,revision,entries:{...entries}});
 };
 const ready=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{fail('未连接 Forge 状态存储');reject(Error('APP_STORAGE_TIMEOUT'));},8000);
  window.addEventListener('message',event=>{
   const m=event.data;
   if(event.source!==window.parent||event.origin!==options.hostOrigin||m?.protocol!==protocol||m.channel!==channel)return;
   if(m.op==='ready'&&!session){
    if(typeof m.session!=='string'||!m.entries||typeof m.entries!=='object')return;
    session=m.session;entries=Object.assign(Object.create(null),m.entries);revision=m.revision;
    clearTimeout(timer);window.__forgeStorageStatus={status:'ready'};resolve();return;
   }
   if(m.op==='error'&&!session){clearTimeout(timer);fail(m.error);reject(Error(m.error));return;}
   if(m.session!==session)return;
   if(m.op==='saved'&&pending?.seq===m.seq){clearTimeout(pending.timer);pending=null;revision=m.revision;window.__forgeStorageStatus={status:'saved'};flush();}
   else if(m.op==='error'){clearTimeout(timer);if(pending)clearTimeout(pending.timer);fail(m.error);reject(Error(m.error));}
  });
 });
 // Preserve old-origin persisted data as an initial import, never replace existing parent truth.
 const legacy=Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]));
 const hello=setInterval(()=>{if(!session)post({op:'hello',legacy});},500);
 try{post({op:'hello',legacy});await ready;}finally{clearInterval(hello);}
 const methods={
  getItem:key=>Object.hasOwn(entries,String(key))?entries[String(key)]:null,
  setItem:(key,value)=>{if(blocked)throw Error('APP_STORAGE_BLOCKED');entries[String(key)]=String(value);dirty=true;flush();},
  removeItem:key=>{if(blocked)throw Error('APP_STORAGE_BLOCKED');delete entries[String(key)];dirty=true;flush();},
  clear:()=>{if(blocked)throw Error('APP_STORAGE_BLOCKED');entries=Object.create(null);dirty=true;flush();},
  key:index=>Object.keys(entries)[Number(index)]??null
 };
 const virtual=new Proxy(Object.create(Storage.prototype),{
  get:(_,key)=>key==='length'?Object.keys(entries).length:key in methods?methods[key]:typeof key==='string'?methods.getItem(key):undefined,
  set:(_,key,value)=>{methods.setItem(key,value);return true;},
  deleteProperty:(_,key)=>{methods.removeItem(key);return true;},
  ownKeys:()=>Object.keys(entries),getOwnPropertyDescriptor:(_,key)=>Object.hasOwn(entries,key)?{configurable:true,enumerable:true,value:entries[key],writable:true}:undefined
 });
 Object.defineProperty(window,'localStorage',{get:()=>virtual,configurable:false});
 window.__forgeStorageFlush=()=>flush();
 window.addEventListener('beforeunload',event=>{if(pending||dirty){event.preventDefault();event.returnValue='';}});
 await launch();
}
