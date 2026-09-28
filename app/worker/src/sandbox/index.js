/**
 * SandboxProvider 接口定义(保留以便后续接入其他执行环境)。
 *
 * 每个 provider 必须实现:
 *   create(projectHint)           -> { sandboxId }
 *   ensure(sandboxId)             -> { sandboxId, alive }
 *   writeFile(sandboxId, path, content) -> void
 *   readFile(sandboxId, path)     -> string
 *   listFiles(sandboxId, dir)     -> string[]
 *   exec(sandboxId, command, opts)-> { exitCode, stdout, stderr, timedOut }
 *   previewUrl(sandboxId, port)   -> string
 *   destroy(sandboxId)            -> void
 */
import { DaytonaProvider } from './daytona.js';

const providers = {
  daytona: DaytonaProvider,
};

export function getSandboxProvider(name = 'daytona') {
  const Provider = providers[name];
  if (!Provider) throw new Error(`Unknown sandbox provider: ${name}`);
  return new Provider();
}

export function registerSandboxProvider(name, Provider) {
  providers[name] = Provider;
}
