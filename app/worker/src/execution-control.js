import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const controlErrors = new WeakSet();
export const currentExecution = () => storage.getStore();
export const withExecutionControl = (context, fn) => storage.run(context, fn);
/** DOMException.code 可为数字；只有平台字符串错误码才能按前缀判断。 */
export function isSupabaseError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SUPABASE_');
}
export function assertExecutionActive() {
  currentExecution()?.signal.throwIfAborted();
}
export async function beforeModelCall() {
  assertExecutionActive();
  try { await currentExecution()?.checkLease(); }
  catch (error) {
    if (error && typeof error === 'object') controlErrors.add(error);
    throw error;
  }
  assertExecutionActive();
}

/** Auxiliary failures may be warnings; execution permission failures never are. */
export function rethrowExecutionControl(error) {
  assertExecutionActive();
  if (controlErrors.has(error) || ['LEASE_LOST', 'ABORTED', 'TASK_TIMEOUT', 'TASK_PAUSED', 'TASK_CANCELLED'].includes(error?.code)) throw error;
}

/** 串行探测，避免慢请求导致多个检查堆叠。失败即停止，不在未知权限下继续花费。 */
export function monitorExecution(check, abort, intervalMs = 3000) {
  let stopped = false;
  let timer;
  const tick = async () => {
    try { await check(); }
    catch (error) { if (!stopped) abort(error); return; }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}

/** 不取消已经送往沙箱的命令，但阻止其返回后继续执行下一项操作。 */
export function guardedSandbox(sandbox) {
  return new Proxy(sandbox, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return async (...args) => {
        assertExecutionActive();
        const result = await value.apply(target, args);
        assertExecutionActive();
        return result;
      };
    },
  });
}
