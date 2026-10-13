import { assertEnvironment, assertKeyProject } from '../../shared/environment.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 若 app/worker/.env 存在则加载;已存在的进程环境变量优先,不覆盖。 */
export const envFileExplicit = Boolean(process.env.FORGE_ENV_FILE);
const envPath = process.env.FORGE_ENV_FILE || fileURLToPath(new URL('../.env', import.meta.url));
if (process.env.FORGE_ENV_FILE && !existsSync(envPath)) throw new Error('ENVIRONMENT_ISOLATION: explicit env file missing');
if (process.env.FORGE_ENVIRONMENT_ID === 'atoms-demo' && !envFileExplicit) throw new Error('ENVIRONMENT_ISOLATION: atoms-demo requires FORGE_ENV_FILE');

export const envFileLoaded = existsSync(envPath);
export const envFilePath = envPath;

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
  const pairs = parseEnvLines(readFileSync(envPath, 'utf8'));
  const source = Object.fromEntries(pairs);
  if ((process.env.FORGE_ENVIRONMENT_ID || source.FORGE_ENVIRONMENT_ID) === 'atoms-demo') {
    if (!envFileExplicit || ['FORGE_ENVIRONMENT_ID','EXPECTED_SUPABASE_PROJECT_REF','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'].some(k=>!source[k]))
      throw new Error('ENVIRONMENT_ISOLATION: demo env source must be complete; no fallback to ambient/Main .env');
    assertEnvironment({environmentId:source.FORGE_ENVIRONMENT_ID,expectedRef:source.EXPECTED_SUPABASE_PROJECT_REF,supabaseUrl:source.SUPABASE_URL,explicit:true});
    if(source.FORGE_ENVIRONMENT_ID!=='atoms-demo')throw new Error('ENVIRONMENT_ISOLATION: demo source profile mismatch; Main env fallback forbidden');
    assertKeyProject(source.SUPABASE_SERVICE_ROLE_KEY,source.EXPECTED_SUPABASE_PROJECT_REF);

  }
  for (const [key, value] of pairs) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
