import { sourceError } from './managed-source.js';
/** Phase 2 does not pretend arbitrary npm scripts are staged source mutations. */
export function validateRuntimeScript(manifest, kind) {
  const pkg = manifest.files.find((f) => f.path === 'package.json');
  const script = pkg && JSON.parse(pkg.content).scripts?.[kind];
  const flags = '(?: --[A-Za-z][A-Za-z-]*(?: [A-Za-z0-9_./=:-]+)?)*';
  const pattern = kind === 'build' ? `^(?:tsc(?: -b| --noEmit)? && )?vite build${flags}$` : `^vite${flags}$`;
  if (typeof script !== 'string' || !new RegExp(pattern).test(script.trim())) {
    throw sourceError('WORKSPACE_RUNTIME_RESTRICTED', `首版仅开放受控 Vite ${kind} recipe；未执行任意 shell/后台源码改写。请使用文件工具，复杂脚本需后续隔离支持。`);
  }
}
