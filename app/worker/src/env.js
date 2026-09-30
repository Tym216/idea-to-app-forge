import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 若 app/worker/.env 存在则加载;已存在的进程环境变量优先,不覆盖。 */
const envPath = fileURLToPath(new URL('../.env', import.meta.url));

export const envFileLoaded = existsSync(envPath);

/** 仅两个 JSON options 允许跨行；在下一个环境变量前停止，不能吞掉密钥。 */
export function parseEnvLines(source) {
  const lines = source.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (['PLAN_PROVIDER_OPTIONS', 'BUILD_PROVIDER_OPTIONS'].includes(key) && value.startsWith('{')) {
      for (let count = 0; count < 32 && i + 1 < lines.length; count += 1) {
        try { JSON.parse(value); break; } catch { /* may be a multi-line object */ }
        const next = lines[i + 1].trim();
        if (/^[A-Z][A-Z0-9_]*\s*=/.test(next)) break;
        i += 1;
        value += '\n' + next;
      }
    }
    const hash = value.search(/\s#/);
    if (hash >= 0 && !value.startsWith('"') && !value.startsWith("'")) value = value.slice(0, hash).trim();
    value = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
    pairs.push([key, value]);
  }
  return pairs;
}

if (envFileLoaded) {
  for (const [key, value] of parseEnvLines(readFileSync(envPath, 'utf8'))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
