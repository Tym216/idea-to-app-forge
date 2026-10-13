import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, Loader2, Monitor, RotateCw } from 'lucide-react';
import type { ViewState } from '@/lib/taskView';
import type { PreviewRecovery } from '@/lib/supabase';

const EMPTY_TEXT: Record<ViewState, { icon: typeof Monitor; title: string; body: string }> = {
  paused: { icon: Clock, title: '任务已暂停', body: '代码已保留。在左侧继续任务后生成预览。' },
  empty: { icon: Monitor, title: '还没有预览', body: '选择 Build 提交需求,或批准计划后,应用在沙箱中构建并启动后会显示在这里。' },
  waiting: { icon: Clock, title: '排队等待中', body: '任务已提交,等待 Worker 领取。关闭页面不影响执行。' },
  running: { icon: Loader2, title: '正在构建', body: '启动成功后这里会加载真实运行的应用。进度见左侧。' },
  failed: { icon: AlertTriangle, title: '本轮未产出预览', body: '查看左侧失败原因,选择恢复任务或新建任务。' },
  success: { icon: CheckCircle2, title: '任务已完成但没有预览地址', body: '可能是 Plan 任务或沙箱已回收;再次 Build 会重新启动。' },
  review: { icon: Clock, title: '等待你审阅计划', body: '在「计划」页批准后才会开始构建。' },
};

/** 真实预览:iframe 指向 Daytona 沙箱预览地址;无地址时按任务状态给出说明。 */
export function PreviewPane({ label, url, state = 'empty', recovery, recoveryError, recoveryPending, onRecover }: {
  label?:string; url: string | null; state?: ViewState; recovery?: PreviewRecovery | null; recoveryError?: string;
  recoveryPending?: boolean; onRecover?: () => void;
}) {
  const [nonce, setNonce] = useState(0);
  const recovering = recoveryPending || recovery?.status === 'queued' || recovery?.status === 'running';
  const transient=/network|fetch|timeout|503|502/i.test(recoveryError || '');
  const waiting=!!(recovering || transient);
  const problem=recovery?.status==='failed' ? recovery.error || '预览恢复失败' : !waiting ? recoveryError || '' : '';
  if (waiting || problem) return (
    <div className="h-full grid place-items-center p-6" role="status">
      <div className="text-center max-w-[420px]">
        {problem ? <AlertTriangle className="h-6 w-6 mx-auto" /> : <Loader2 className="h-6 w-6 mx-auto animate-spin" />}
        <p className="mt-2 font-medium">{problem ? '预览暂不可用' : '正在启动预览…'}</p>
        <p className="mt-2 text-[13px] text-[var(--text-2)]">{problem || '正在等待 Worker 恢复已有应用，不调用模型。Worker 离线时会保持等待；应用和源码仍已保存。'}</p>
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
        <button type="button" aria-label="检查并刷新预览" onClick={() => onRecover ? onRecover() : setNonce((n) => n + 1)} className="btn-ghost grid h-7 w-7 place-items-center rounded-[6px]">
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <a href={url} target="_blank" rel="noreferrer" aria-label="在新窗口打开预览" className="btn-ghost grid h-7 w-7 place-items-center rounded-[6px]">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      <iframe key={`${nonce}:${recovery?.execution_id ?? ''}:${recovery?.updated_at ?? ''}`} src={url} title="应用预览" className="flex-1 w-full bg-white" />
    </div>
  );
}
