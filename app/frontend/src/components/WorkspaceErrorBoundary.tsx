import {Component,Fragment,useEffect,useState,type ErrorInfo,type ReactNode} from 'react';

type Props={projectId:string;children:ReactNode;onRecover:()=>void;onBack:()=>void};
type State={failed:boolean;attempts:number;epoch:number};
/** A display retry reads the same persisted project; it never resubmits a generation task. */
export class WorkspaceErrorBoundary extends Component<Props,State>{
 state:State={failed:false,attempts:0,epoch:0};
 private timer:ReturnType<typeof setTimeout>|undefined;
 static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(error:Error,info:ErrorInfo){
  const diagnostic={at:new Date().toISOString(),projectId:this.props.projectId,name:error.name,
   message:error.message.slice(0,400),componentStack:info.componentStack?.slice(0,1600)};
  // Local diagnostics only. No prompt/source/token capture or remote reporting.
  try{const previous=JSON.parse(localStorage.getItem('forge-workspace-ui-errors')||'[]');
   localStorage.setItem('forge-workspace-ui-errors',JSON.stringify([...(Array.isArray(previous)?previous:[]).slice(-4),diagnostic]));
  }catch{/* Disabled browser storage must not break the recovery UI. */}
  console.error('WORKSPACE_RENDER_ERROR',diagnostic);
  if(this.state.attempts===0)this.timer=setTimeout(()=>this.recover(true),600);
 }
 componentWillUnmount(){clearTimeout(this.timer);}
 private recover=(automatic=false)=>{
  clearTimeout(this.timer);
  this.props.onRecover();
  this.setState(state=>({failed:false,attempts:automatic?state.attempts+1:1,epoch:state.epoch+1}));
 };
 render(){
  if(!this.state.failed)return <Fragment key={this.state.epoch}>{this.props.children}</Fragment>;
  const retrying=this.state.attempts===0;
  return <main className="min-h-screen bg-[var(--bg)] text-[var(--text)] grid place-items-center p-6">
   <section className="max-w-lg rounded-xl border border-[var(--line)] bg-[var(--panel)] p-6 space-y-3" role={retrying?'status':'alert'}>
    <h1 className="font-semibold text-lg">{retrying?'正在恢复工作区显示…':'工作区显示暂时异常'}</h1>
    <p>项目、计划和已保存代码仍然保留。{retrying?'正在重新读取已有项目，不会重复提交生成任务。':'可以重新读取当前项目，无需新建或重新生成。'}</p>
    {!retrying&&<div className="flex gap-2"><button className="forge-btn forge-btn-primary" onClick={()=>this.recover()}>重新读取项目</button><button className="forge-btn forge-btn-neutral" onClick={this.props.onBack}>返回项目列表</button></div>}
    <p className="text-xs text-[var(--text-2)]">显示错误不会自动停止后台任务。诊断编号：WORKSPACE_RENDER_ERROR</p>
   </section>
  </main>;
 }
}

/** Visible local diagnostics let a recovered first-entry error be inspected without DevTools. */
export function WorkspaceRenderDiagnostics({projectId}:{projectId?:string}){
 const [records,setRecords]=useState<unknown[]>([]),[notice,setNotice]=useState('');
 useEffect(()=>{try{const data=JSON.parse(localStorage.getItem('forge-workspace-ui-errors')||'[]');
  setRecords(Array.isArray(data)?data.filter(r=>r?.projectId===projectId):[]);
 }catch{setRecords([]);}},[projectId]);
 if(!records.length)return null;
 return <details className="mt-2 text-xs"><summary>工作区显示恢复记录（{records.length}）</summary>
  <p>仅保存在本浏览器，不包含任务需求、源码或登录凭据。</p>
  <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(records,null,2)}</pre>
  <button className="forge-btn forge-btn-secondary mt-2" onClick={()=>{void navigator.clipboard.writeText(JSON.stringify(records,null,2)).then(()=>setNotice('诊断已复制'),()=>setNotice('复制失败，可选中上方内容复制'));}}>复制显示诊断</button>
  {notice&&<p role="status">{notice}</p>}
 </details>;
}
