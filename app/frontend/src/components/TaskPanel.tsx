import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, CircleDashed, Clock, Loader2, RotateCcw, Play, XCircle } from 'lucide-react';
import type { Stage, Task } from '@/lib/supabase';
import { retryTask, pauseTask, resumeTask, cancelTask } from '@/lib/data';
import { TaskFeedback } from '@/components/TaskFeedback';
import { STATE_LABEL, activityText, currentActivity, fmtTime, parseTaskError, stagesOf, viewState, verificationAttempts, isVerificationStop, hasQuickRepair } from '@/lib/taskView';

const STAGE_ICON: Record<Stage['status'], { icon: typeof Circle; text: string; cls: string }> = {
  pending: { icon: Circle, text: '待开始', cls: 'text-[var(--text-2)]' },
  running: { icon: Loader2, text: '进行中', cls: 'text-[var(--accent)]' },
  done: { icon: CheckCircle2, text: '完成', cls: 'text-[var(--success)]' },
  failed: { icon: XCircle, text: '待处理', cls: 'text-[var(--danger)]' },
};

const STATE_ICON = { empty: CircleDashed, waiting: Clock, running: Loader2, paused: Clock, failed: AlertTriangle, success: CheckCircle2, review: Clock };

type Props = { current: Task | null; history: Task[]; onChanged: () => void | Promise<void>; retry?: typeof retryTask };

/** 当前任务状态卡 + 阶段进度 + 可展开日志 + 历史待处理(标注轮次)。 */
export function TaskPanel({ current, history, onChanged, retry: retryFn = retryTask }: Props) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const state = viewState(current);
  const Icon = STATE_ICON[state];
  const stages = stagesOf(current);
  const err = current?.status === 'failed' ? parseTaskError(current.error) : null;
  type VerifyIssue = { id: string; status: string; reason?: string; stepResults?: Array<{ index: number; op: string; ok: boolean; expected?: unknown; actual?: unknown; observed?: unknown }> };
  type LogicCheck = {status:string;tests?:number;passed?:number;failed?:number;details?:string};
  const report = current?.steps?.findLast((s) => s.tool === 'verify_report')?.result as {kind?:string;validationMode?:string;base?:unknown;logicChecks?:LogicCheck;items?:VerifyIssue[]} | undefined;
  // Legacy reports omitted base/logic evidence; the already persisted logic_check is authoritative too.
  const logic = report?.logicChecks ?? current?.steps?.findLast(s=>s.tool==='logic_check')?.result as LogicCheck|undefined;
  const mode=report?.validationMode ?? (current?.steps?.findLast(s=>s.tool==='verify_attempt')?.result as {mode?:string}|undefined)?.mode;
  const logicFailed=logic?.status==='failed';
  const checksLabel=mode==='http' ? logic?'服务与逻辑检查':'服务检查':'浏览器验收';
  const issues = report?.items?.filter((item) => item.status !== 'verified') ?? [];
  const completedWithWarnings = current?.status === 'succeeded' && current.phase === 'done_with_warnings';
  const recentActivity = current?.steps?.filter((s) => s.event !== 'started').slice(-4) ?? [];
  const verifyCount = current ? verificationAttempts(current) : 0;
  const verifyLimitReached = verifyCount >= 2;
  const verifyFailure = !!current && isVerificationStop(current);
  const repaired = !!current && hasQuickRepair(current);
  const failureReason=verifyFailure&&logicFailed ? `代码逻辑检查有 ${logic.failed ?? '部分'} 项待核对断言，需核对实现或测试样例` : err?.reason;
  const failureNext=verifyFailure&&logicFailed ? '代码和预览地址已保留。可先查看预览，再根据具体问题继续完善。' : err?.next;
  const control = async (action: typeof pauseTask) => {
    if (!current || pending) return;
    setPending(true);
    setError('');
    try { await action(current.id); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };

  const retry = async (kind: 'new' | 'resume') => {
    if (!current) return;
    setPending(true);
    setError('');
    try {
      await retryFn(current.id, kind);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  if (!current) {
    return (
      <section aria-label="当前任务" className="p-4 text-[13px] text-[var(--text-2)]">
        <p className="flex items-center gap-2 font-medium text-[var(--text)]">
          <CircleDashed className="h-4 w-4" aria-hidden /> 暂无任务
        </p>
        <p className="mt-1">在下方输入需求。Plan 先出计划供审阅;Build 直接生成并运行应用。</p>
      </section>
    );
  }

  return (
    <section aria-label="当前任务" className="p-4 space-y-3">
      <div className="flex items-start gap-2">
        <Icon
          className={`h-4 w-4 mt-0.5 shrink-0 ${state === 'running' ? 'animate-spin text-[var(--accent)]' : state === 'failed' ? 'text-[var(--danger)]' : state === 'success' ? 'text-[var(--success)]' : 'text-[var(--text-2)]'}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold">
            {verifyFailure ? '有待完善项' : completedWithWarnings ? '已生成 · 检查有待核对项' : STATE_LABEL[state]}
          </p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] text-[var(--text-2)]">
            <dt>模式</dt>
            <dd className="text-[var(--text)]">
              {current.mode === 'plan' ? 'Plan(只出计划)' : 'Build(生成并运行)'}
              {current.plan_version ? ` · 计划 v${current.plan_version}` : ''}
            </dd>
            <dt>任务</dt>
            <dd className="font-mono truncate">
              第 {current.round ?? '—'} 轮 · #{current.id.slice(0, 8)}
              {current.kind === 'resume' ? ` · 已恢复 ${current.resumes} 次` : current.retry_of ? ' · 重新创建' : ''}
            </dd>
            <dt>开始</dt>
            <dd>{fmtTime(current.started_at ?? current.created_at)}</dd>
            <dt>更新</dt>
            <dd>{fmtTime(current.updated_at)}</dd>
            {verifyCount > 0 && <><dt>{checksLabel}</dt><dd>已执行 {verifyCount} 次 · 每任务最多 2 次</dd></>}
          </dl>
        </div>
      </div>

      {['queued', 'running', 'paused'].includes(current.status) && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <button type="button" disabled={pending || (current.status === 'paused' && verifyLimitReached)} onClick={() => control(current.status === 'paused' ? resumeTask : pauseTask)} className="btn-ghost h-8 px-3 rounded-[6px] text-[12px]">
              {pending ? '正在处理…' : current.status === 'paused' ? '继续任务' : '暂停任务'}
            </button>
            {current.status === 'paused' && <button type="button" disabled={pending} onClick={() => control(cancelTask)} className="btn-ghost h-8 px-3 rounded-[6px] text-[12px]">结束任务</button>}
          </div>
          <p className="text-[11px] text-[var(--text-2)]">暂停保留已保存代码和剩余预算。Worker 通常数秒内中止模型请求；已计算的部分仍可能计费，沙箱命令可能仍在收尾。继续会从已保存内容重新接续；结束任务后可提交新需求。</p>
          {verifyLimitReached && <p className="text-[12px] text-[var(--text-2)]">验收次数已用完。请先结束本任务，检查失败条件或修订计划，再明确开始新任务；现有预览保留。</p>}
        </div>
      )}
      {error && <p role="alert" className="text-[12px] text-[var(--danger)]">{error}</p>}

      <div aria-label="实时活动" aria-live="polite" className="rounded-[8px] border border-[var(--line)] px-3 py-2">
        <p className="text-[11px] font-medium text-[var(--text-2)]">实时活动 · 真实执行记录</p>
        <p className="mt-1 text-[13px] text-[var(--text)]">{currentActivity(current)}</p>
        {recentActivity.length > 0 && (
          <ol className="mt-2 space-y-1 border-t border-[var(--line)] pt-2">
            {recentActivity.map((s, i) => (
              <li key={`${s.at}-${i}`} className="flex gap-2 text-[12px] text-[var(--text-2)]">
                <time className="shrink-0 font-mono">{new Date(s.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                <span className="truncate">{activityText(s)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {stages.length > 0 && (
        <ol className="space-y-1" aria-label="执行步骤">
          {stages.map((s) => {
            const meta = STAGE_ICON[s.status];
            const StageIcon = meta.icon;
            return (
              <li key={s.key} className="flex items-center gap-2 text-[13px]">
                <StageIcon className={`h-3.5 w-3.5 shrink-0 ${meta.cls} ${s.status === 'running' && state !== 'paused' ? 'animate-spin' : ''}`} aria-hidden />
                <span className={s.status === 'pending' ? 'text-[var(--text-2)]' : ''}>{s.label}</span>
                <span className={`text-[12px] ${meta.cls}`}>{state === 'paused' && s.status === 'running' ? '已暂停' : meta.text}</span>
                {s.note && <span className="text-[12px] text-[var(--text-2)] truncate">· {verifyFailure && s.status === 'failed' ? '有待完善项，详见诊断' : s.note}</span>}
              </li>
            );
          })}
        </ol>
      )}

      {(completedWithWarnings || (current.status==='failed'&&(issues.length>0||logicFailed))) && (
        <div role="status" className="rounded-[8px] border border-[var(--line)] p-3 space-y-2 text-[12px]">
          <p className="font-medium">{completedWithWarnings
            ? '应用已生成并可以预览。自动验收发现非阻塞警告，你仍可以打开预览继续测试。'
            : logicFailed ? '代码逻辑检查发现待核对问题，代码和预览已保留。' : '自动检查尚未完成，代码和预览已保留；详细证据可在开发者诊断中查看。'}</p>
          {logic&&<p>代码逻辑检查：{logic.tests ?? '—'} 项中 {logic.passed ?? '—'} 项通过{logicFailed?`，${logic.failed ?? '部分'} 项待核对；需检查实现和测试样例。`:'。'}</p>}
          {mode==='http'&&<p>浏览器交互检查已关闭，A1 等功能项未执行；这些未执行项不会被标记为通过。</p>}
          <p className="text-[var(--text-2)]">未验证项没有被标记为通过。</p>
          <details>
            <summary className="cursor-pointer text-[var(--text-2)]">开发者诊断 · {checksLabel}</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify({...report,validationMode:mode,logicChecks:logic,items:issues},null,2)}</pre>
          </details>
        </div>
      )}

      {err && (
        <div role={verifyFailure ? 'status' : 'alert'} className={`rounded-[8px] border ${verifyFailure ? 'border-[var(--line)]' : 'border-[var(--danger)]'} p-3 space-y-2`}>
          <p className="text-[13px] font-medium text-[var(--danger)] flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {verifyFailure ? repaired ? '快速完善已结束，仍有待处理项。' : '检查有待确认项。' : `本轮暂未完成：${failureReason}`}
          </p>
          {current.last_tool && !err.code.startsWith('LLM_') && (
            <p className="text-[12px] text-[var(--text-2)]">
              最后执行:{current.last_tool}
              {current.last_tool_ms != null ? `(${Math.round(current.last_tool_ms / 1000)} 秒)` : ''}
            </p>
          )}
          {(verifyFailure || failureNext) && <p className="text-[12px]">下一步:{verifyFailure ? '可以先查看当前预览，或根据详情继续完善。当前结果尚未确认为稳定版本。' : failureNext}</p>}
          <div className="flex flex-wrap gap-2">
            {!verifyLimitReached && <button type="button" disabled={pending} onClick={() => retry('resume')} className="btn-ghost h-8 px-3 rounded-[6px] text-[12px] inline-flex items-center gap-1">
              <Play className="h-3.5 w-3.5" aria-hidden /> {verifyFailure&&logicFailed&&current.operation!=='user_apply' ? '核对并继续修复' : verifyFailure ? '继续完善' : '恢复任务'}
            </button>}
            <button type="button" disabled={pending || current.operation==='user_apply'} onClick={() => retry('new')} className="btn-ghost h-8 px-3 rounded-[6px] text-[12px] inline-flex items-center gap-1">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> 新建任务重试
            </button>
          </div>
          <p className="text-[11px] text-[var(--text-2)]">
            {current.operation==='user_apply' ? '手工修改不会调用模型修复。已确认源码保留；重新加载编辑后 Apply，或恢复原任务继续固定验证。' : verifyFailure || verifyLimitReached ? 'Agent 最多自动快速修正一轮（4 次模型调用、90 秒决策预算）；已发出的构建会安全收尾。同一任务最多检查两次，暂停或恢复不清零。继续完善可能消耗模型额度。' : '恢复任务:沿用同一任务编号、已写入的代码和步骤继续;恢复会重置本次步数与修复额度,最多恢复 3 次。新建任务:保留这条失败记录,从头开始新的一轮。'}
          </p>
          {err.raw && (
            <details>
              <summary className="text-[12px] text-[var(--text-2)] cursor-pointer">原始错误</summary>
              <pre className="mt-1 max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-[var(--text-2)]">{err.raw}</pre>
            </details>
          )}
        </div>
      )}

      {current && <TaskFeedback task={current} />}

      {current.steps?.length > 0 && (
        <details>
          <summary className="text-[12px] text-[var(--text-2)] cursor-pointer">详细日志({current.steps.length} 条)</summary>
          <ul className="mt-2 max-h-56 overflow-auto space-y-1">
            {current.steps.map((s, i) => (
              <li key={i} className="font-mono text-[11px] leading-4 text-[var(--text-2)] border-l-2 border-[var(--line)] pl-2">
                <span className="text-[var(--text)]">{s.tool}{s.path ? ` · ${s.path}` : ''}{s.event === 'started' ? ' · 开始' : ''}</span>
                {s.ok === false ? ' ✗' : s.ok ? ' ✓' : ''}
                {s.ms != null ? ` ${Math.round(s.ms)}ms` : ''} · {s.observation.slice(0, 400)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {history.length > 0 && (
        <details className="pt-2 border-t border-[var(--line)]">
          <summary className="text-[12px] text-[var(--text-2)] cursor-pointer">历史待处理({history.length} 轮,不属于当前任务)</summary>
          <ul className="mt-2 space-y-1">
            {history.map((t) => (
              <li key={t.id} className="text-[12px] text-[var(--text-2)]">
                第 {t.round ?? '—'} 轮 · {t.mode} · {fmtTime(t.finished_at ?? t.updated_at)} — {parseTaskError(t.error)?.reason ?? '失败'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
