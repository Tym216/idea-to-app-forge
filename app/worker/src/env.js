import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 若 app/worker/.env 存在则加载;已存在的进程环境变量优先,不覆盖。 */
const envPath = fileURLToPath(new URL('../.env', import.meta.url));

export const envFileLoaded = existsSync(envPath);

if (envFileLoaded) {
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.search(/\s#/);
    if (hash >= 0 && !value.startsWith('"') && !value.startsWith("'")) value = value.slice(0, hash).trim();
    value = value.replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
