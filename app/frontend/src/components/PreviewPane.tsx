import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, Loader2, Monitor, RotateCw } from 'lucide-react';
import {resetPreviewStorage} from '../../../shared/preview-storage.js';
import {usePreviewStorage,type PreviewStorageIdentity} from '@/lib/previewStorage';
import type { ViewState } from '@/lib/taskView';
import type { PreviewRecovery } from '@/lib/supabase';

const EMPTY_TEXT: Record<ViewState, { icon: typeof Monitor; title: string; body: string }> = {
  paused: { icon: Clock, title: '任务已暂停', body: '代码已保留。在左侧继续任务后生成预览。' },
  empty: { icon: Monitor, title: '还没有预览', body: '选择 Build 提交需求,或批准计划后,应用在沙箱中构建并启动后会显示在这里。' },
  waiting: { icon: Clock, title: '排队等待中', body: '任务已提交,等待 Worker 领取。关闭页面不影响执行。' },
  running: { icon: Loader2, title: '正在构建', body: '启动成功后这里会加载真实运行的应用。进度见左侧。' },
  failed: { icon: AlertTriangle, title: '本轮未产出预览', body: '查看左侧处理建议，选择继续完善或开始新任务。' },
  success: { icon: CheckCircle2, title: '任务已完成但没有预览地址', body: '可能是 Plan 任务或沙箱已回收;再次 Build 会重新启动。' },
  review: { icon: Clock, title: '等待你审阅计划', body: '在「计划」页批准后才会开始构建。' },
};

/** 真实预览:iframe 指向 Daytona 沙箱预览地址;无地址时按任务状态给出说明。 */
export function PreviewPane({ label, url, storageIdentity, checkingWorkspace, state = 'empty', recovery, recoveryError, recoveryPending, onRecover, onUpgradePlatform }: {
  storageIdentity?:PreviewStorageIdentity; label?:string; checkingWorkspace?:boolean; url: string | null; state?: ViewState; recovery?: PreviewRecovery | null; recoveryError?: string;
  recoveryPending?: boolean; onRecover?: () => void; onUpgradePlatform?:()=>void;
}) {
  const [nonce, setNonce] = useState(0);
  const frame=useRef<HTMLIFrameElement>(null);
  const storageStatus=usePreviewStorage(frame,url,storageIdentity,nonce);
  const [resetError,setResetError]=useState('');
  const resetData=async()=>{
   if(!storageIdentity||!window.confirm('重置当前项目的业务数据？所有 App 版本共享这些数据，源码和版本记录不会删除。'))return;
   try{await resetPreviewStorage(storageIdentity);setResetError('');setNonce(n=>n+1);}
   catch(e){setResetError(e instanceof Error?e.message:String(e));}
  };
  const recovering = recoveryPending || recovery?.status === 'queued' || recovery?.status === 'running';
  const transient=/network|fetch|timeout|503|502/i.test(recoveryError || '');
  // Background metadata/recovery must not tear down an already usable iframe.
  const waiting=!url&&!!(recovering || transient);
  const problem=!url&&recovery?.status==='failed' ? recovery.error || '预览恢复失败' : !url&&!waiting ? recoveryError || '' : '';
  if (waiting || problem) return (
    <div className="h-full grid place-items-center p-6" role="status">
      <div className="text-center max-w-[420px]">
        {problem ? <AlertTriangle className="h-6 w-6 mx-auto" /> : <Loader2 className="h-6 w-6 mx-auto animate-spin" />}
        <p className="mt-2 font-medium">{problem ? '工作区暂时无法确认' : checkingWorkspace ? '正在确认工作区状态…' : '正在启动预览…'}</p>
        <p className="mt-2 text-[13px] text-[var(--text-2)]">{problem ? '代码与草稿已保留。详细原因可在开发者诊断中查看。' : '正在等待 Worker 恢复已有应用，不调用模型。Worker 离线时会保持等待；应用和源码仍已保存。'}</p>
        {problem && onRecover && <button type="button" onClick={onRecover} disabled={!!recoveryPending} className="btn-ghost mt-3 px-3 py-2">重新检查预览</button>}
      </div>
    </div>
  );

  if (!url) {
    const e = EMPTY_TEXT[state];
    const Icon = e.icon;
    return (
      <div className="h-full grid place-items-center p-6">
        <div className="text-center max-w-[420px]">
          <Icon className={`h-6 w-6 mx-auto text-[var(--text-2)] ${state === 'running' ? 'animate-spin' : ''}`} aria-hidden />
          <p className="mt-2 text-[14px] font-medium">{e.title}</p>
          <p className="mt-1 text-[13px] text-[var(--text-2)]">{e.body}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-9 px-3 flex items-center gap-2 border-b border-[var(--line)]">
        <span className="text-[11px] text-[var(--accent)] shrink-0">{label ?? 'Working Workspace'}</span>
        <span className="flex-1 truncate font-mono text-[12px] text-[var(--text-2)]">{url}</span>
        {storageStatus==='unavailable'&&(onUpgradePlatform||onRecover)&&<button type="button" disabled={!!recovering} className="forge-btn forge-btn-secondary text-xs" onClick={()=>{
         if(window.confirm('为旧应用启用平台状态保存？首次会重启已有预览运行环境；已保存数据保留，尚未保存的内存状态无法自动迁移。'))(onUpgradePlatform||onRecover)?.();
        }}>启用状态保留</button>}
        {storageIdentity&&<button type="button"  className="forge-btn forge-btn-neutral text-xs" onClick={()=>void resetData()}>重置业务数据</button>}
        <button type="button" aria-label="检查并刷新预览" onClick={() => { setNonce((n) => n + 1); onRecover?.(); }} className="btn-ghost grid h-7 w-7 place-items-center rounded-[6px]">
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs shrink-0" role="status">{storageStatus==='error'?'状态保存异常':storageStatus==='saved'?'状态已保存':storageStatus==='ready'?'状态已恢复':''}</span>
        <a href={storageIdentity?'/preview/'+storageIdentity.projectId:url} target="_blank" rel="noreferrer" aria-label="在新窗口打开预览" className="btn-ghost grid h-7 w-7 place-items-center rounded-[6px]">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      {resetError&&<p role="alert">{resetError}</p>}
      <iframe ref={frame} key={`${nonce}:${url}`} src={url} title="应用预览" className="flex-1 w-full bg-white" />
    </div>
  );
}
