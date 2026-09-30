/**
 * 构建进度与防空转保护:
 * - 连续相同的失败调用:先提示换方案,持续重复则 AGENT_STALLED
 * - 构建/预览门槛:未成功构建不许 start_dev,未取得预览不许 finish
 * - 修改代码后使构建验证失效
 * - 修复轮数达到上限:抛出 AgentStopError,由循环层终止
 */
export class AgentStopError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'AgentStopError';
    this.code = code;
  }
}

export const MAX_VERIFY_ATTEMPTS = 2;
// Old rows lack verify_attempt; count only a completed browser result, not rejected arguments.
const legacyVerification = (step) => step.tool === 'verify' && step.event === 'finished'
  && /验收通过|验收未通过|验收工具故障|浏览器验收/.test(step.observation || '');
/** 以持久化的开始记录计数，暂停/恢复不能清零；兼容旧版的完成记录。 */
export function verificationAttempts(steps = []) {
  let count = 0;
  let marked = false;
  for (const step of steps || []) {
    if (step.tool === 'verify_attempt') { count++; marked = true; }
    else if (!marked && legacyVerification(step)) count++;
  }
  return count;
}

/** Budget limits the expensive verification itself, never the repair path. */
export function requireVerificationBudget(task) {
  if (verificationAttempts(task.steps) >= MAX_VERIFY_ATTEMPTS) {
    throw new AgentStopError('VERIFY_ATTEMPT_LIMIT', '本任务已用完两次浏览器验收机会。代码与预览保留；请检查验收定义或修订计划后开始新任务。');
  }
}

/** A failed check can be repeated only after a confirmed code-changing action. */
export function requireNewRevisionForVerification(task) {
  const steps = task.steps || [];
  const lastAttempt = steps.findLastIndex((step) => step.tool === 'verify_attempt' || legacyVerification(step));
  if (lastAttempt < 0) return;
  const changed = steps.slice(lastAttempt + 1).some((step) => step.event === 'finished' && step.ok === true
    && ['write_file', 'delete_file'].includes(step.tool) && step.code_changed !== false
    || (step.tool === 'change_journal' && step.event === 'resolved' && step.state === 'succeeded'
      && step.intended_hash !== step.before_sandbox_hash));
  // Shell commands can alter files, but their result is not yet synchronized/confirmed as a code revision.
  if (!changed) throw new AgentStopError('VERIFY_REVISION_UNCHANGED', '上次验收后没有确认的代码修改；不能对同一版本重复验收。请先修复代码，或修订错误的计划。');
}

const CODE_MODIFYING = /(\bnpm\s+(i|install|add|uninstall|remove|update)\b|\bnpx\b|\byarn\b|\bpnpm\b|\bgit\b|\brm\b|\bmv\b|\bcp\b|\bsed\b|\btee\b|\btouch\b|\bmkdir\b|>|\bpatch\b|\bnode\b)/;

export function mayModifyCode(command = '') {
  return CODE_MODIFYING.test(String(command));
}

export class BuildProgress {
  constructor({ maxFixRounds, maxRepeats = 3, fixRounds = 0 } = {}) {
    this.maxFixRounds = maxFixRounds;
    this.maxRepeats = maxRepeats;
    this.fixRounds = fixRounds;
    this.lastFailureKey = null;
    this.repeatCount = 0;
    this.buildOk = false;
    this.previewUrl = '';
    this.verification = null;
  }

  /** 记录一次工具结果,返回需要追加给模型的提示;持续重复时抛出 AGENT_STALLED。 */
  recordResult(tool, args, ok) {
    if (ok) {
      this.lastFailureKey = null;
      this.repeatCount = 0;
      return '';
    }
    const key = `${tool}:${JSON.stringify(args ?? {})}`;
    this.repeatCount = key === this.lastFailureKey ? this.repeatCount + 1 : 1;
    this.lastFailureKey = key;
    if (this.repeatCount >= this.maxRepeats) {
      throw new AgentStopError('AGENT_STALLED', `相同失败调用 ${tool} 连续出现 ${this.repeatCount} 次,已停止`);
    }
    if (this.repeatCount >= 2) {
      return `\n\n注意:该调用与上一次完全相同且再次失败,请调整参数或换一种方式,不要重复。`;
    }
    return '';
  }

  invalidate() {
    this.buildOk = false;
    this.previewUrl = '';
    this.verification = null;
  }

  /** 记录构建结果;达到修复上限时抛出 FIX_LIMIT_REACHED。 */
  recordBuild(ok) {
    if (ok) {
      this.buildOk = true;
      return;
    }
    this.buildOk = false;
    this.previewUrl = '';
    this.verification = null;
    this.fixRounds += 1;
    if (this.fixRounds > this.maxFixRounds) {
      throw new AgentStopError('FIX_LIMIT_REACHED', `构建连续失败,已达到修复轮数上限 ${this.maxFixRounds}`);
    }
  }

  recordPreview(url) {
    if (this.buildOk && url) {
      this.previewUrl = url;
      this.verification = null;
    }
  }

  canVerify() {
    if (!this.buildOk) return '尚未成功构建,不能 verify。请先 build。';
    if (!this.previewUrl) return '尚未启动应用,不能 verify。请先 start_dev。';
    return '';
  }

  recordVerification(result) {
    this.verification = result?.kind === 'passed' ? result : null;
  }

  recordVerificationFailure() {
    this.verification = null;
    this.fixRounds += 1;
    if (this.fixRounds > this.maxFixRounds) {
      throw new AgentStopError('FIX_LIMIT_REACHED', `验收失败已达到修复轮数上限 ${this.maxFixRounds}`);
    }
  }

  canStartDev() {
    return this.buildOk ? '' : '尚未成功构建,不能 start_dev。请先调用 build 并修复所有错误。';
  }

  canFinish() {
    if (!this.buildOk) return '尚未成功构建(或构建后又修改了代码),不能 finish。请先 build。';
    if (!this.previewUrl) return '尚未启动开发服务器并取得预览地址,不能 finish。请先 start_dev。';
    if (!this.verification) return '浏览器验收尚未通过,不能 finish。请先调用 verify 并修复失败项。';
    return '';
  }
}
