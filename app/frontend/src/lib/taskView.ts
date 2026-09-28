import type { Stage, Task, TaskStep } from './supabase';

export type ViewState = 'empty' | 'waiting' | 'running' | 'paused' | 'failed' | 'success' | 'review';

export type ParsedError = { code: string; reason: string; next: string; lastTool: string | null; raw: string };

/** Worker 把错误写成 JSON {code,reason,next,raw};旧格式为纯文本堆栈。 */
export function parseTaskError(error: string | null): ParsedError | null {
  if (!error) return null;
  try {
    const v = JSON.parse(error);
    if (v && typeof v.reason === 'string') {
      return { code: v.code || 'ERROR', reason: v.reason, next: v.next || '', lastTool: v.lastTool ?? null, raw: v.raw || '' };
    }
  } catch {
    /* 纯文本 */
  }
  return { code: 'ERROR', reason: error.split('\n')[0].slice(0, 160), next: '查看原始错误后重试', lastTool: null, raw: error };
}

export function viewState(task: Task | null): ViewState {
  if (!task) return 'empty';
  if (task.status === 'queued') return 'waiting';
  if (task.status === 'running') return 'running';
  if (task.status === 'paused') return 'paused';
  if (task.status === 'failed' || task.status === 'cancelled') return 'failed';
  if (task.mode === 'plan') return 'review';
  return 'success';
}

export const STATE_LABEL: Record<ViewState, string> = {
  empty: '未开始',
  waiting: '排队等待',
  running: '执行中',
  paused: '已暂停',
  failed: '失败',
  success: '已完成',
  review: '等待你审阅计划',
};

const PHASE_TEXT: Record<string, string> = {
  queued: '等待 Worker 领取',
  claimed: '已领取,准备开始',
  resumed: '恢复任务,等待领取',
  understand: '正在读取项目要求',
  designing: '正在构思设计方向',
  planning: '正在编写计划',
  action_planning: '正在整理构建步骤',
  deciding: '正在调用模型确定下一步',
  paused: '已暂停，等待你继续',
  format_retry: '模型输出格式无效，正在纠正',
  llm_request: '正在调用模型',
  llm_response: '模型已返回，正在处理',
  awaiting_review: '等待你审阅计划',
  action_plan: '已生成行动计划',
  sandbox: '准备运行环境',
  react: '正在准备生成应用',
  verify: '正在验收应用交互',
  list_files: '读取现有代码',
  read_file: '读取现有代码',
  write_file: '修改代码',
  delete_file: '修改代码',
  run_command: '执行命令',
  build: '安装依赖并构建',
  fixing: '构建失败,正在修复',
  start_dev: '启动应用',
  finishing: '预览已就绪',
  done: '已完成',
  error: '已失败',
  cancelled: '已取消',
};

export function phaseText(phase: string): string {
  return PHASE_TEXT[phase] || phase;
}

const TOOL_ACTIVITY: Record<string, [string, string]> = {
  list_files: ['正在查看文件列表', '已查看文件列表'],
  read_file: ['正在读取', '已读取'],
  write_file: ['正在写入', '已写入'],
  delete_file: ['正在删除', '已删除'],
  run_command: ['正在执行命令', '命令已执行'],
  build: ['正在构建应用', '应用构建完成'],
  start_dev: ['正在启动预览', '预览服务已启动'],
  verify: ['正在验收应用交互', '应用验收已执行'],
  design: ['正在构思设计方向', '设计方向已确定'],
  plan: ['正在编写计划', '计划已生成'],
  sandbox: ['正在准备沙箱', '沙箱已准备'],
  finish: ['正在收尾', '任务已完成'],
};

export function activityText(step: TaskStep): string {
  if (['llm', 'llm_parse_error', 'verify_attempt', 'pause', 'resume', 'cancel'].includes(step.tool)) return step.observation;
  if (step.phase === 'awaiting_review') return step.observation || '计划已完成，请审阅';
  const [doing, done] = TOOL_ACTIVITY[step.tool] || ['正在执行操作', '操作已完成'];
  if (step.event === 'started') return step.path ? `${doing} ${step.path}` : doing;
  if (step.ok === false) return step.path ? `${step.path} 操作失败` : `${doing.replace('正在', '')}失败`;
  return step.path ? `${done} ${step.path}` : done;
}

export function currentActivity(task: Task): string {
  const last = task.steps?.at(-1);
  if (task.status === 'running' && last?.event === 'started') return activityText(last);
  return phaseText(task.phase);
}

export function verificationAttempts(task: Task): number {
  let count = 0;
  let marked = false;
  for (const step of task.steps || []) {
    if (step.tool === 'verify_attempt') { count++; marked = true; }
    else if (!marked && step.tool === 'verify' && step.event === 'finished') count++;
  }
  return count;
}

export function stagesOf(task: Task | null): Stage[] {
  const plan = task?.plan;
  if (!Array.isArray(plan) || !plan.length || typeof plan[0] !== 'object') return [];
  return plan as Stage[];
}

/** 当前任务 = 最新一条;其余失败任务作为历史错误,并标注轮次。 */
export function splitTasks(tasks: Task[]): { current: Task | null; history: Task[] } {
  const [current = null, ...rest] = tasks;
  return { current, history: rest.filter((t) => t.status === 'failed') };
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
