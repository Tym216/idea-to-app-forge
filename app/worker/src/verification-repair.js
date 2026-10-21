import { AgentStopError, verificationAttempts, MAX_VERIFY_ATTEMPTS } from './build-progress.js';

export const VERIFY_REPAIR_LIMITS = Object.freeze({ modelCalls: 4, durationMs: 90_000 });
const marker = 'verification_repair';

// One durable episode per task: resume/Worker restart must not renew automatic repair.
export function canRepairVerification(task, error, workspace) {
  return error?.code === 'VERIFY_FAILED' && (task.operation ?? 'agent') === 'agent'
    && workspace?.state.state === 'confirmed' && !workspace.state.writer
    && workspace.state.verify?.status === 'blocker'
    && verificationAttempts(task.steps) < MAX_VERIFY_ATTEMPTS
    && !(task.steps || []).some(step => step.tool === marker && step.event === 'started');
}

export class VerificationRepair {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.deadline = now() + VERIFY_REPAIR_LIMITS.durationMs;
    this.calls = 0;
  }
  check() {
    if (this.now() >= this.deadline) throw this.stopped('time_limit');
  }
  nextCall() {
    this.check();
    if (this.calls >= VERIFY_REPAIR_LIMITS.modelCalls) throw this.stopped('model_call_limit');
    this.calls++;
    return Math.max(1, Math.ceil(this.deadline - this.now()));
  }
  beforeTool(tool) {
    this.check();
    // Arbitrary commands cannot safely be interrupted or bounded as a short repair.
    if (tool === 'run_command') throw this.stopped('command_not_allowed');
  }
  stopped(reason) {
    return Object.assign(new AgentStopError('VERIFY_REPAIR_LIMIT',
      '本轮快速完善已结束，已确认代码与预览地址保留；仍有待处理项，可查看详情后决定是否继续。'), { repairReason: reason });
  }
}

export function verificationRepairPrompt(error) {
  return `自动检查发现阻断问题。现在只进行一次短修复，最多 ${VERIFY_REPAIR_LIMITS.modelCalls} 次模型调用，共享 90 秒时间预算。基于以下实际证据定位并做最小修正，优先读取相关文件，再用 apply_changes(after=build) 修改并检查。不要重做整个应用，不要重复无变化验收，不执行 run_command。已批准 acceptance 不可修改或放宽；不得删除/跳过失败测试或降低断言来通过。若证据不足或规则冲突，request_plan_revision 并说明原因。功能未验收不能声称通过。\n检查证据：\n${String(error.message).slice(0, 7000)}`;
}
