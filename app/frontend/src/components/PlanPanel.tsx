import { useEffect, useState } from 'react';
import { CheckCircle2, FileText, MessageSquare } from 'lucide-react';
import type { Plan, PlanFeedback } from '@/lib/supabase';
import { approvePlan, revisePlan } from '@/lib/data';
import { fmtTime } from '@/lib/taskView';

type Props = {
  plans: Plan[];
  feedback: PlanFeedback[];
  busy: boolean;
  onChanged: () => void | Promise<void>;
  actions?: { approve: typeof approvePlan; revise: typeof revisePlan };
};

const STATUS_TEXT: Record<Plan['status'], string> = { draft: '待审阅', approved: '已批准', superseded: '已被新版本替代' };

/** 计划审阅:展示最新计划版本、回答问题/提意见、绑定版本批准并构建。 */
export function PlanPanel({ plans, feedback, busy, onChanged, actions = { approve: approvePlan, revise: revisePlan } }: Props) {
  const reviewable = plans.filter((p) => p.kind === 'plan');
  const [viewId, setViewId] = useState<string>('');
  const plan = reviewable.find((p) => p.id === viewId) ?? reviewable[0];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setAnswers({});
    setExtra('');
    setError('');
  }, [plan?.id]);

  if (!plan) {
    return (
      <div className="p-6 text-[13px] text-[var(--text-2)]">
        <p className="font-medium text-[var(--text)]">还没有计划</p>
        <p className="mt-1">{busy ? '正在准备计划。具体进度见左侧实时活动；完成后可在这里审阅。' : '在左侧选择 Plan 并描述需求，Agent 会先给出计划供你审阅，不会修改代码。'}</p>
      </div>
    );
  }

  const latest = plan.id === reviewable[0]?.id;
  const canAct = latest && plan.status === 'draft' && !busy && !pending;
  const c = plan.content;
  const questions = c.questions ?? [];
  const planFeedback = feedback.filter((f) => f.plan_version <= plan.version);

  const run = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const hasInput = extra.trim().length > 0 || Object.values(answers).some((v) => v.trim());

  return (
    <div className="h-full overflow-auto">
      <div className="px-5 py-4 border-b border-[var(--line)] flex flex-wrap items-center gap-2">
        <FileText className="h-4 w-4 text-[var(--text-2)]" aria-hidden />
        <h2 className="text-[15px] font-semibold">计划 v{plan.version}</h2>
        <span
          className={`text-[12px] px-2 h-6 inline-flex items-center rounded-[6px] border ${
            plan.status === 'approved' ? 'border-[var(--success)] text-[var(--success)]' : 'border-[var(--line)] text-[var(--text-2)]'
          }`}
        >
          {plan.status === 'approved' && <CheckCircle2 className="h-3.5 w-3.5 mr-1" aria-hidden />}
          {STATUS_TEXT[plan.status]}
        </span>
        <span className="text-[12px] text-[var(--text-2)]">{fmtTime(plan.created_at)}</span>
        {reviewable.length > 1 && (
          <select
            aria-label="查看计划版本"
            value={plan.id}
            onChange={(e) => setViewId(e.target.value)}
            className="ml-auto h-8 px-2 rounded-[6px] border border-[var(--line)] bg-[var(--panel)] text-[12px]"
          >
            {reviewable.map((p) => (
              <option key={p.id} value={p.id}>
                v{p.version} · {STATUS_TEXT[p.status]}
              </option>
            ))}
          </select>
        )}
      </div>

      {!latest && (
        <p className="mx-5 mt-4 text-[12px] rounded-[6px] border border-[var(--line)] p-2 text-[var(--text-2)]">
          你正在查看旧版本,只读。请切换到 v{reviewable[0].version} 审阅与批准。
        </p>
      )}

      <article className="px-5 py-4 space-y-5 text-[14px] leading-[22px]">
        <section>
          <h3 className="text-[12px] font-semibold uppercase tracking-[.04em] text-[var(--text-2)] mb-1">需求理解</h3>
          <p>{c.understanding}</p>
        </section>
        {c.scope?.length ? (
          <section>
            <h3 className="text-[12px] font-semibold uppercase tracking-[.04em] text-[var(--text-2)] mb-1">功能范围</h3>
            <ul className="list-disc pl-5 space-y-0.5">{c.scope.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </section>
        ) : null}
        {c.flows?.length ? (
          <section>
            <h3 className="text-[12px] font-semibold uppercase tracking-[.04em] text-[var(--text-2)] mb-1">核心流程</h3>
            <ol className="list-decimal pl-5 space-y-0.5">{c.flows.map((s, i) => <li key={i}>{s}</li>)}</ol>
          </section>
        ) : null}
        {c.rules?.length ? (
          <section>
            <h3 className="text-[12px] font-semibold uppercase tracking-[.04em] text-[var(--text-2)] mb-1">关键规则</h3>
            <ul className="list-disc pl-5 space-y-0.5">{c.rules.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </section>
        ) : null}
        {c.storage && <p className="text-[var(--text-2)]">数据保存：{c.storage}</p>}
        <section>
          <h3 className="text-[12px] font-semibold uppercase tracking-[.04em] text-[var(--text-2)] mb-1">实现步骤</h3>
          <ol className="list-decimal pl-5 space-y-0.5">{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </section>
        {c.acceptance?.length ? (
          <section>
            <h3 className="text-[12px] font-semibold uppercase tracking-[.04em] text-[var(--text-2)] mb-1">验收条件</h3>
            <ol className="space-y-2">{c.acceptance.map((a) => (
              <li key={a.id}>
                <span className="font-medium">{a.id}</span> · {a.action} → {a.expect}{a.external ? '（需外部服务）' : a.severity === 'core' ? '（核心流程）' : a.severity === 'detail' ? '（细节检查）' : '（未分级）'}
                {a.steps?.length ? <details className="mt-1 text-[12px] text-[var(--text-2)]"><summary className="cursor-pointer">查看固定的浏览器检查</summary><pre className="mt-1 overflow-auto whitespace-pre-wrap">{JSON.stringify(a.steps, null, 2)}</pre></details> : null}
              </li>
            ))}</ol>
          </section>
        ) : null}
        {c.design && (
          <section>
            <h3 className="text-[12px] font-semibold uppercase tracking-[.04em] text-[var(--text-2)] mb-1">设计方向</h3>
            <p>{c.design}</p>
          </section>
        )}

        {canAct && questions.length > 0 && (
          <section className="space-y-4" aria-label="需要确认的问题">
            <h3 className="text-[12px] font-semibold uppercase tracking-[.04em] text-[var(--text-2)]">需要你确认({questions.length})</h3>
            {questions.map((q) => (
              <fieldset key={q.id} className="space-y-2">
                <legend className="font-medium">{q.question}</legend>
                <div className="flex flex-wrap gap-2">
                  {q.options.map((opt) => {
                    const on = answers[q.id] === opt;
                    return (
                      <button
                        key={opt}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                        className={`h-8 px-3 rounded-[6px] border text-[13px] ${
                          on ? 'border-[var(--accent)] text-[var(--accent)] bg-[#EEEEFB]' : 'border-[var(--line)] hover:border-[var(--accent)]'
                        }`}
                      >
                        {on ? '✓ ' : ''}
                        {opt}
                        {q.recommended === opt ? '(推荐)' : ''}
                      </button>
                    );
                  })}
                </div>
                <input
                  aria-label={`${q.question} 自由输入`}
                  placeholder="或自行填写"
                  value={q.options.includes(answers[q.id] ?? '') ? '' : answers[q.id] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  className="w-full h-9 px-3 rounded-[6px] border border-[var(--line)] bg-[var(--panel)] text-[13px]"
                />
              </fieldset>
            ))}
          </section>
        )}

        {planFeedback.length > 0 && (
          <section>
            <h3 className="text-[12px] font-semibold uppercase tracking-[.04em] text-[var(--text-2)] mb-1 flex items-center gap-1">
              <MessageSquare className="h-3.5 w-3.5" aria-hidden /> 你的反馈
            </h3>
            <ul className="space-y-1 text-[13px]">
              {planFeedback.map((f) => (
                <li key={f.id} className="rounded-[6px] border border-[var(--line)] px-3 py-2">
                  <span className="text-[var(--text-2)]">针对 v{f.plan_version} · </span>
                  {f.content || '(仅回答问题)'}
                  {Object.keys(f.answers || {}).length > 0 && (
                    <span className="text-[var(--text-2)]"> — {Object.values(f.answers).join(' / ')}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>

      {canAct && (
        <div className="sticky bottom-0 bg-[var(--panel)] border-t border-[var(--line)] px-5 py-3 space-y-2">
          <label htmlFor="plan-extra" className="block text-[12px] text-[var(--text-2)]">
            还有什么其他补充?(可跳过)
          </label>
          <textarea
            id="plan-extra"
            rows={2}
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="对计划的修改意见,或补充信息"
            className="w-full rounded-[6px] border border-[var(--line)] p-2 text-[13px] resize-none bg-[var(--panel)]"
          />
          {error && <p role="alert" className="text-[12px] text-[var(--danger)]">{error}</p>}
          <div className="flex flex-wrap gap-2 justify-end">
            <button
              type="button"
              disabled={!hasInput || pending}
              onClick={() => run(() => actions.revise(plan.id, plan.version, extra.trim(), answers))}
              className="btn-ghost h-9 px-4 rounded-[6px] text-[13px]"
            >
              提交意见,修改计划
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => actions.approve(plan.id, plan.version))}
              className="btn-primary h-9 px-4 rounded-[6px] text-[13px] font-medium"
            >
              {pending ? '处理中…' : `批准 v${plan.version} 并构建`}
            </button>
          </div>
        </div>
      )}
      {!canAct && latest && plan.status === 'draft' && busy && (
        <p className="px-5 pb-4 text-[12px] text-[var(--text-2)]">当前有任务在执行,完成后可批准或修改计划。</p>
      )}
    </div>
  );
}
