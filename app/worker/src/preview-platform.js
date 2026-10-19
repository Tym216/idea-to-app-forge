
import {createHash} from 'node:crypto';
import {previewLoadGuard} from '../../shared/preview-load-guard.js';
import {previewBootstrap} from '../../shared/preview-storage.js';
/** Vite-only runtime adapter; generated managed source and immutable versions stay unchanged. */
export const PREVIEW_RUNTIME_VERSION='forge-preview-storage-v1';
export function createPreviewPlugin(options,bootstrapSource,loadGuardSource) {
 if(typeof loadGuardSource!=='string'||!loadGuardSource.trim())throw Error('FORGE_PREVIEW_LOAD_GUARD_REQUIRED');
 const inline=new Map();
 return {
  name:'forge-platform-storage',
  transformIndexHtml:{order:'post',handler(html){
   const modules=[];
   html=html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi,(tag,attributes,code)=>{
    if(!/\btype\s*=\s*['"]module['"]/i.test(attributes)){
     if(/\btype\s*=\s*['"](?:application\/json|application\/ld\+json)['"]/i.test(attributes))return tag;
     throw Error('FORGE_PREVIEW_UNSUPPORTED: executable classic scripts cannot run before storage hydration');
    }
    const src=attributes.match(/\bsrc\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if(src)modules.push({src});
    else {
     const id=createHash('sha256').update(code).digest('hex');inline.set(id,code);
     modules.push({src:'/__forge__/inline/'+id+'.js'});
    }
    return src?'<script type="application/forge-deferred-module" src="'+src+'"></script>':'';
   });
   const payload=JSON.stringify({options,modules}).replaceAll('<','\\u003c');
   return html.replace(/<head\b[^>]*>/i,tag=>tag+
    '<script type="module">const p='+payload+';await ('+loadGuardSource+')(p.options,async()=>{const {boot}=await import("/__forge__/platform.js");await boot(p.options,p.modules);});</script>');
  }},
  configureServer(server){
   server.middlewares.use((req,res,next)=>{
    if(req.url==='/__forge__/platform.js'){
     res.setHeader('Content-Type','text/javascript');res.setHeader('Cache-Control','no-store');
     res.end('export const boot='+bootstrapSource+';');return;
    }
    const id=req.url?.match(/^\/__forge__\/inline\/([0-9a-f]{64})\.js$/)?.[1];
    if(id&&inline.has(id)){res.setHeader('Content-Type','text/javascript');res.end(inline.get(id));return;}
    if(req.url==='/__forge__/runtime'){
     res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:'forge-preview-storage-v1',fingerprint:options.runtimeFingerprint}));return;
    }
    next();
   });
  }
 };
}
export const PREVIEW_RUNTIME_FINGERPRINT=createHash('sha256').update(createPreviewPlugin.toString()+previewBootstrap.toString()+previewLoadGuard.toString()).digest('hex');
export function previewHostOrigin(settings) {
 const configured=settings.forgePublicOrigin ||
  (settings.environmentId==='atoms-demo'?'https://idea-to-app-forge.onrender.com':null);
 if(!configured)throw Error('FORGE_PUBLIC_ORIGIN_REQUIRED');
 const url=new URL(configured);
 if(url.origin!==configured || (url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname)))throw Error('FORGE_PUBLIC_ORIGIN_INVALID');
 return url.origin;
}
export function renderPreviewConfig(settings,owner) {
 const options={hostOrigin:previewHostOrigin(settings),projectId:owner.projectId,allowLocalValidation:true,runtimeFingerprint:PREVIEW_RUNTIME_FINGERPRINT};
 return `import {createHash} from 'node:crypto';
import {loadConfigFromFile,mergeConfig} from 'vite';
const env={command:'serve',mode:'development',isSsrBuild:false,isPreview:false};
const original=await loadConfigFromFile(env,undefined,process.cwd());
const plugin=(${createPreviewPlugin.toString()})(${JSON.stringify(options)},${JSON.stringify(previewBootstrap.toString())},${JSON.stringify(previewLoadGuard.toString())});
export default mergeConfig(original?.config||{},{plugins:[plugin]});
`;
}
export function platformDevCommand(command) {
 if(!/^npm run --ignore-scripts dev(?: -- .*)?$/.test(command))throw Error('FORGE_PREVIEW_UNSUPPORTED_COMMAND');
 return command+(command.includes(' -- ')?' ':' -- ')+'--config .forge-preview/vite.config.mjs';
}
export const PLATFORM_RUNTIME_PROBE='curl -sf http://127.0.0.1:5173/__forge__/runtime';
