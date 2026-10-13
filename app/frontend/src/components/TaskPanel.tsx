import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, CircleDashed, Clock, Loader2, RotateCcw, Play, XCircle } from 'lucide-react';
import type { Stage, Task } from '@/lib/supabase';
import { retryTask, pauseTask, resumeTask, cancelTask } from '@/lib/data';
import { TaskFeedback } from '@/components/TaskFeedback';
import { STATE_LABEL, activityText, currentActivity, fmtTime, parseTaskError, stagesOf, viewState, verificationAttempts } from '@/lib/taskView';

const STAGE_ICON: Record<Stage['status'], { icon: typeof Circle; text: string; cls: string }> = {
  pending: { icon: Circle, text: '待开始', cls: 'text-[var(--text-2)]' },
  running: { icon: Loader2, text: '进行中', cls: 'text-[var(--accent)]' },
  done: { icon: CheckCircle2, text: '完成', cls: 'text-[var(--success)]' },
  failed: { icon: XCircle, text: '失败', cls: 'text-[var(--danger)]' },
};

const STATE_ICON = { empty: CircleDashed, waiting: Clock, running: Loader2, paused: Clock, failed: AlertTriangle, success: CheckCircle2, review: Clock };

type Props = { current: Task | null; history: Task[]; onChanged: () => void | Promise<void>; retry?: typeof retryTask };

/** 当前任务状态卡 + 阶段进度 + 可展开日志 + 历史失败(标注轮次)。 */
export function TaskPanel({ current, history, onChanged, retry: retryFn = retryTask }: Props) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const state = viewState(current);
  const Icon = STATE_ICON[state];
  const stages = stagesOf(current);
  const err = current?.status === 'failed' ? parseTaskError(current.error) : null;
  type VerifyIssue = { id: string; status: string; reason?: string; stepResults?: Array<{ index: number; op: string; ok: boolean; expected?: unknown; actual?: unknown; observed?: unknown }> };
  const report = current?.steps?.findLast((s) => s.tool === 'verify_report')?.result as { kind?: string; items?: VerifyIssue[] } | undefined;
  const issues = report?.items?.filter((item) => item.status !== 'verified') ?? [];
  const completedWithWarnings = current?.status === 'succeeded' && current.phase === 'done_with_warnings';
  const recentActivity = current?.steps?.filter((s) => s.event !== 'started').slice(-4) ?? [];
  const verifyCount = current ? verificationAttempts(current) : 0;
  const verifyLimitReached = verifyCount >= 2;
  const verifyFailure = !!err?.code.startsWith('VERIFY_');
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
            {completedWithWarnings ? '已生成 · 验收有待核对项' : STATE_LABEL[state]}
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
            {verifyCount > 0 && <><dt>浏览器验收</dt><dd>已执行 {verifyCount} 次 · 每任务最多 2 次</dd></>}
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
                {s.note && <span className="text-[12px] text-[var(--text-2)] truncate">· {s.note}</span>}
              </li>
            );
          })}
        </ol>
      )}

      {(completedWithWarnings || (current.status === 'failed' && issues.length > 0)) && (
        <div role="status" className="rounded-[8px] border border-[var(--line)] p-3 space-y-2 text-[12px]">
          <p className="font-medium">{completedWithWarnings ? '预览已保留。以下条件未被验证通过；这不代表它们已实现。' : '验收发现明确故障，以下是失败证据。'}</p>
          <ul className="space-y-2">{issues.map((issue) => (
            <li key={issue.id} className="border-l-2 border-[var(--accent)] pl-2">
              <span className="font-medium">{issue.id} · {issue.status === 'blocker' ? '核心故障' : issue.status === 'warning' ? '警告' : '证据不足'}</span>
              {issue.reason && <p className="whitespace-pre-wrap">{issue.reason}</p>}
              {issue.stepResults?.filter((step) => !step.ok).map((step) => (
                <div key={step.index} className="mt-1">
                  <p>步骤 {step.index} {step.op} · 预期：{String(step.expected ?? '—')} · 结果：{String(step.actual ?? '未知')}</p>
                  {step.observed && <pre className="mt-1 overflow-auto whitespace-pre-wrap text-[11px]">{JSON.stringify(step.observed, null, 2)}</pre>}
                </div>
              ))}
            </li>
          ))}</ul>
          <p className="text-[var(--text-2)]">{completedWithWarnings ? '可以继续使用当前预览；要修复请提交新的 Build 需求，要调整验收定义请切换 Plan 并审阅新版本。' : '代码与预览已保留。可主动恢复或提交修复任务；验收定义有误时请切换 Plan 修订。'}</p>
        </div>
      )}

      {err && (
        <div role="alert" className="rounded-[8px] border border-[var(--danger)] p-3 space-y-2">
          <p className="text-[13px] font-medium text-[var(--danger)] flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> 本轮失败:{err.reason}
          </p>
          {current.last_tool && !err.code.startsWith('LLM_') && (
            <p className="text-[12px] text-[var(--text-2)]">
              最后执行:{current.last_tool}
              {current.last_tool_ms != null ? `(${Math.round(current.last_tool_ms / 1000)} 秒)` : ''}
            </p>
          )}
          {err.next && <p className="text-[12px]">下一步:{err.next}</p>}
          <div className="flex flex-wrap gap-2">
            {!verifyLimitReached && <button type="button" disabled={pending} onClick={() => retry('resume')} className="btn-ghost h-8 px-3 rounded-[6px] text-[12px] inline-flex items-center gap-1">
              <Play className="h-3.5 w-3.5" aria-hidden /> {verifyFailure ? '手动重试一次' : '恢复任务'}
            </button>}
            <button type="button" disabled={pending || current.operation==='user_apply'} onClick={() => retry('new')} className="btn-ghost h-8 px-3 rounded-[6px] text-[12px] inline-flex items-center gap-1">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> 新建任务重试
            </button>
          </div>
          <p className="text-[11px] text-[var(--text-2)]">
            {current.operation==='user_apply' ? '手工修改不会调用模型修复。已确认源码保留；重新加载编辑后 Apply，或恢复原任务继续固定验证。' : verifyFailure || verifyLimitReached ? '验收失败不会自动修复；同一任务最多验收两次，暂停或恢复不会清零。新建任务是明确开启新一轮，会再次调用模型。' : '恢复任务:沿用同一任务编号、已写入的代码和步骤继续;恢复会重置本次步数与修复额度,最多恢复 3 次。新建任务:保留这条失败记录,从头开始新的一轮。'}
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
          <summary className="text-[12px] text-[var(--text-2)] cursor-pointer">历史失败({history.length} 轮,不属于当前任务)</summary>
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
