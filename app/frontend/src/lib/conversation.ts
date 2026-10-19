import { hasQuickRepair, isVerificationStop, quickRepairActive } from './taskView';
import type {AppVersion,Message,Plan,Task} from './supabase';
const technical=/locator\.|bodyText|Traceback|WORKSPACE_|(?:Error:|\bat .*file:\/\/)|^\s*[{[]/;
export const shortIntent=(s?:string)=>{const line=(s||'').split('\n')[0].trim();return !line||technical.test(line)||/^(?:修改|新增|删除)\s+(?:src\/|package\.|index\.html)/.test(line)?'':line.slice(0,72);};
export function versionTitle(v:AppVersion,intent?:string){return shortIntent(intent)||(/^Initial(?: app)?$/i.test(v.label||'')?'':shortIntent(v.label))||(!v.parent_checkpoint_id?'Initial app':'源码更新');}
export function changedPaths(task?:Task){
 const out=new Set<string>();for(const s of task?.steps||[]){
  if(s.event==='finished'&&s.ok&&s.path&&['write_file','delete_file'].includes(s.tool))out.add(s.path);
  if(s.tool==='user_apply')for(const f of (s.result as {files?:{path:string}[]})?.files||[])out.add(f.path);
 }return [...out];
}
export type ConversationTurn={id:string;user?:Message;tasks:Task[];messages:Message[];versions:AppVersion[];intent:string};
export function conversationTurns(messages:Message[],tasks:Task[],versions:AppVersion[],plans:Plan[]=[]){
 const turns:ConversationTurn[]=[],byTask=new Map<string,ConversationTurn>(),claimed=new Set<string>();
 for(const user of messages.filter(m=>m.role==='user')){
  const task=tasks.find(t=>t.id===user.task_id)||[...tasks].reverse().find(t=>!claimed.has(t.id)&&t.prompt===user.content);
  const turn={id:user.id,user,tasks:task?[task]:[],messages:[],versions:[],intent:shortIntent(user.content)} as ConversationTurn;
  turns.push(turn);if(task){byTask.set(task.id,turn);claimed.add(task.id);}
 }
 const attach=(t:Task):ConversationTurn=>{
  const known=byTask.get(t.id);if(known)return known;
  const source=t.retry_of||plans.find(p=>p.id===t.plan_id)?.source_task_id;
  const parent=source&&source!==t.id?tasks.find(x=>x.id===source):undefined;
  let turn=parent?attach(parent):undefined;
  if(!turn){turn={id:'task:'+t.id,tasks:[],messages:[],versions:[],intent:shortIntent(t.prompt)};turns.push(turn);}
  turn.tasks.push(t);byTask.set(t.id,turn);return turn;
 };
 for(const t of [...tasks].reverse())attach(t);
 for(const m of messages.filter(m=>m.role==='assistant')){
  let turn=m.task_id?byTask.get(m.task_id):undefined;
  if(!turn){turn={id:'message:'+m.id,tasks:[],messages:[],versions:[],intent:''};turns.push(turn);}
  turn.messages.push(m);
  const id=m.meta?.appVersionId??m.meta?.checkpointId,v=typeof id==='string'?versions.find(v=>v.id===id):undefined;
  if(v&&!turn.versions.some(x=>x.id===v.id))turn.versions.push(v);
 }
 for(const turn of turns)turn.tasks.sort((a,b)=>tasks.indexOf(a)-tasks.indexOf(b));
 return turns.sort((a,b)=>{
  const at=a.user?.created_at||a.tasks.at(-1)?.created_at||a.messages[0]?.created_at;
  const bt=b.user?.created_at||b.tasks.at(-1)?.created_at||b.messages[0]?.created_at;
  return at&&bt?at.localeCompare(bt):0;
 });
}
export function turnResponse(turn:ConversationTurn){
 const task=turn.tasks[0],version=turn.versions.at(-1);
 if(task && isVerificationStop(task)) return hasQuickRepair(task)
  ? '本轮快速完善已结束，仍有待处理项。已保存代码和预览地址，你可以先查看预览，或提出具体修改继续完善。'
  : '自动检查有待确认项，已保存代码和预览地址。你可以查看预览，或继续完善；未确认的功能不会标为通过。';
 if(task?.status==='failed'){
  let reason='这次操作未完成；项目与已保存的代码保留，可以重试。';
  try{const error=JSON.parse(task.error||'{}');if(error.code==='LLM_PROVIDER_BUSY'||/429/.test(error.reason||''))reason=task.mode==='plan'?'模型服务暂时繁忙，这次没有产生代码修改。你可以重试。':'模型服务暂时繁忙，已保存代码与进度，可以重试。';
   else if(typeof error.reason==='string'&&!technical.test(error.reason))reason=error.reason;
  }catch{/* Raw failures stay behind diagnostics. */}
  return reason;
 }
 if(task?.status==='paused')return '已暂停，代码和进度已保留。';
 if(task?.status==='cancelled')return '本次任务已结束，已保存的项目与代码保留。';
 if(task&&['queued','running'].includes(task.status)){
  if(quickRepairActive(task))return '发现待完善项，正在尝试一次快速修正；到达时间或调用上限就停止。';
  if(task.steps?.at(-1)?.event==='retrying')return '模型服务繁忙，正在重试…';
  if(['build','start_dev','verify'].includes(task.phase))return '正在检查修改…';
  if(task.phase==='edit'||task.phase==='write_file')return '正在修改应用…';
  return '收到，正在查看现有应用…';
 }
 if(version){
  const title=shortIntent(turn.intent)||'这次修改';
  if(version.verify_evidence?.result?.validationMode==='http')return '应用代码已生成，构建和 HTTP 检查已完成；页面渲染与功能交互尚未检查，请打开预览确认效果。';
  if(version.verify_evidence?.result?.validationMode==='health')return '修改已保存并更新版本：'+title+'。基础检查通过；未运行功能交互验收。';
  return (version.parent_checkpoint_id?'修改已完成：'+title+'。':'应用已做好，可以开始使用。')+(version.verify_evidence?.status==='passed'?'':'部分自动交互检查尚未确认，请在预览中继续测试。');
 }
 if(task?.mode==='plan'&&task.status==='succeeded')return '开发计划已生成，请审阅后开始构建。';
 const final=turn.messages.at(-1)?.content;return final&&!technical.test(final)?final:'本次操作的结果已保存。';
}
