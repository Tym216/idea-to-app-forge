import type { AppVersion, PreviewRecovery, Project, Task } from './supabase';
export const defaultMode = (project: Project | null) => project?.checkpoint_id ? 'build' as const : 'plan' as const;
export const activeTask = (tasks:Task[]) => tasks.some(t=>['queued','running','paused'].includes(t.status));
export const stableWorkspace = (project:Project|null, version:AppVersion|undefined) => !!project && !!version
 && project.workspace_state==='confirmed' && !project.workspace_writer && project.checkpoint_id===version.id
 && project.workspace_revision===version.workspace_revision && project.workspace_hash===version.code_hash;
export const readyPreview = (project:Project|null, recovery:PreviewRecovery|null|undefined) => !!project && !!recovery
 && recovery.project_id===project.id && recovery.sandbox_id===project.sandbox_id && recovery.status==='ready'
 && recovery.ready_revision===project.workspace_revision && recovery.ready_hash===project.workspace_hash
 && project.workspace_state==='confirmed' && !project.workspace_writer;

/** One automatic request per confirmed source/sandbox basis, never from a poll loop. */
export function previewRecoveryKey(project:Project|null,tasks:Task[],hasSource:boolean):string|null {
 if(!project?.sandbox_id||project.deletion_state||!hasSource||project.workspace_state!=='confirmed'
   ||project.workspace_writer||tasks.some(t=>t.mode==='build'&&['queued','running'].includes(t.status))) return null;
 return [project.id,project.sandbox_id,project.workspace_revision,project.workspace_hash].join(':');
}
export function requestPreviewOnce(key:string|null,attempted:Set<string>,request:()=>Promise<void>):Promise<void>|null {
 if(!key||attempted.has(key)) return null;
 attempted.add(key);
 return request();
}
