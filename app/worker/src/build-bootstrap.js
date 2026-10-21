import {SCAFFOLD_FILES} from './scaffold.js';
import {renderPersistenceHelper,PERSISTENCE_HOOK_SOURCE} from './app-persistence.js';
import {DESIGN_TOKENS_PATH,renderDesignTokensCss} from './design.js';

/** One recorded logical bootstrap, never direct sandbox writes or replacement of user files.
 * File-level side effects still use the normal partial/uncertain/reconcile contract.
 */
export function buildBootstrapChanges(files,options=null){
 const existing=new Map(files.map(f=>[f.path,f.content]));
 const changes=Object.entries(SCAFFOLD_FILES).filter(([path])=>!existing.has(path))
  .map(([path,content])=>({operation:'write',path,content}));
 if(options){
  const {environmentId,projectId,design,preserveDesign=false}=options;
  if(!environmentId||!projectId||!design)throw new Error('Build bootstrap requires explicit environment, project and design');
  const helpers=[['src/forge-persistence.ts',()=>renderPersistenceHelper(environmentId,projectId)],
   ['src/forge-use-app-state.ts',()=>PERSISTENCE_HOOK_SOURCE]];
  for(const [path,render] of helpers)if(!existing.has(path))changes.push({operation:'write',path,content:render()});
  if(!preserveDesign){
   const content=renderDesignTokensCss(design);
   if(existing.get(DESIGN_TOKENS_PATH)!==content)changes.push({operation:'write',path:DESIGN_TOKENS_PATH,content});
  }
 }
 return changes;
}
