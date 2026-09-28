import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
export const currentExecution = () => storage.getStore();
export const withExecutionControl = (context, fn) => storage.run(context, fn);
export function assertExecutionActive() {
  currentExecution()?.signal.throwIfAborted();
}
export async function beforeModelCall() {
  assertExecutionActive();
  await currentExecution()?.checkLease();
  assertExecutionActive();
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
