import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export const cutoverNames = ['CUTOVER_SUPABASE_URL', 'CUTOVER_SUPABASE_SERVICE_ROLE_KEY', 'CUTOVER_SUPABASE_ANON_KEY', 'CUTOVER_DATABASE_URL'];
export class CutoverConfigError extends Error {
  constructor(variable, code) { super(code); this.variable = variable; this.code = code; }
}
const fail = (variable, code) => { throw new CutoverConfigError(variable, code); };
const refPattern = /^[a-z0-9]{20}$/;
function apiRef(value, variable) {
  let url;
  try { url = new URL(value); } catch { fail(variable, 'INVALID_URL'); }
  const ref = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname)?.[1];
  if (url.protocol !== 'https:' || !ref || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) fail(variable, 'UNSUPPORTED_PROJECT_URL');
  return ref;
}
function claims(key, variable) {
  try {
    if (key.split('.').length !== 3) fail(variable, 'EXPECTED_LEGACY_JWT_KEY');
    return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
  } catch (error) {
    if (error instanceof CutoverConfigError) throw error;
    fail(variable, 'INVALID_JWT_FORMAT');
  }
}

/** Cutover config is file-only. Never inherit main Worker credentials or silent process overrides. */
export function loadCutoverConfig({ source, primarySource } = {}) {
  let env, primary;
  try {
    source ??= readFileSync(new URL('../../worker/.env.cutover', import.meta.url), 'utf8');
    primarySource ??= readFileSync(new URL('../../worker/.env', import.meta.url), 'utf8');
    env = parseEnv(source); primary = parseEnv(primarySource);
  } catch { fail('.env.cutover / primary reference', 'ENV_LOAD_FAILED'); }
  for (const name of cutoverNames) {
    if (!env[name]) fail(name, 'MISSING_VALUE');
    if ((source.match(new RegExp('^\\s*'+name+'\\s*=', 'gm')) || []).length !== 1) fail(name, 'DUPLICATE_OR_INVALID_ENV_ENTRY');
  }
  const projectRef = apiRef(env.CUTOVER_SUPABASE_URL, 'CUTOVER_SUPABASE_URL');
  if (!primary.SUPABASE_URL) fail('primary reference', 'PRIMARY_REFERENCE_UNAVAILABLE');
  const primaryRef = apiRef(primary.SUPABASE_URL, 'primary reference');
  if (primaryRef === projectRef) fail('CUTOVER_SUPABASE_URL', 'PRIMARY_PROJECT_FORBIDDEN');
  for (const [variable, role] of [['CUTOVER_SUPABASE_SERVICE_ROLE_KEY', 'service_role'], ['CUTOVER_SUPABASE_ANON_KEY', 'anon']]) {
    const c = claims(env[variable], variable);
    if (c.ref !== projectRef) fail(variable, 'PROJECT_REF_MISMATCH');
    if (c.role !== role) fail(variable, 'ROLE_MISMATCH');
    if (typeof c.exp !== 'number' || c.exp * 1000 <= Date.now()) fail(variable, 'JWT_EXPIRED_OR_NO_EXPIRY');
  }
  let database;
  try { database = new URL(env.CUTOVER_DATABASE_URL); } catch { fail('CUTOVER_DATABASE_URL', 'INVALID_CONNECTION_URL'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.password || database.hash) fail('CUTOVER_DATABASE_URL', 'INVALID_CONNECTION_URL');
  let username;
  try { username = decodeURIComponent(database.username); } catch { fail('CUTOVER_DATABASE_URL', 'INVALID_USERNAME_ENCODING'); }
  const directRef = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(database.hostname)?.[1];
  const pooler = /^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(database.hostname);
  const userRef = /\.([a-z0-9]{20})$/.exec(username)?.[1];
  const databaseRef = directRef || (pooler ? userRef : null);
  if (!refPattern.test(databaseRef || '') || databaseRef !== projectRef || (userRef && userRef !== projectRef)) fail('CUTOVER_DATABASE_URL', 'DATABASE_PROJECT_REF_MISMATCH');
  if (database.searchParams.has('sslmode') && !['require', 'verify-ca', 'verify-full'].includes(database.searchParams.get('sslmode'))) fail('CUTOVER_DATABASE_URL', 'TLS_REQUIRED');
  // Avoid URL sslmode parameters silently overriding certificate validation in node-postgres.
  database.searchParams.delete('sslmode');
  return { projectRef, primaryRef, databaseRef, apiUrl: `https://${projectRef}.supabase.co`,
    serviceKey: env.CUTOVER_SUPABASE_SERVICE_ROLE_KEY, anonKey: env.CUTOVER_SUPABASE_ANON_KEY,
    databaseUrl: database.toString() };
}

export function safeErrorCode(error) {
  const code = error?.code || error?.cause?.code;
  if (!code && /timeout/i.test(String(error?.message||''))) return 'CONNECTION_TIMEOUT';
  return typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code) ? code : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'CONNECTION_ERROR';
}
