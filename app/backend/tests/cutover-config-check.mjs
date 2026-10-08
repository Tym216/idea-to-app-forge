/** Read-only preflight. No migrations, fixtures, RPC mutations or main-env API clients. */
import { loadCutoverConfig, safeErrorCode } from './cutover-config.mjs';
import { publicKeySanityCheck } from './cutover-public-key.mjs';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
const output = (check, status, details = {}) => console.log(JSON.stringify({ check, status, ...details }));
let cfg;
try { cfg = loadCutoverConfig(); }
catch (error) { output('configuration', 'FAIL', { variable: error.variable || '.env.cutover', error_type: safeErrorCode(error) }); process.exit(1); }
if (cfg.projectRef !== 'vtevambqlnezprpezqyf') { output('approved_fresh_target','FAIL',{error_type:'UNAPPROVED_DISPOSABLE_PROJECT'}); process.exit(1); }
output('env_load_and_project_identity', 'OK', { source: 'app/worker/.env.cutover', project_ref: cfg.projectRef, primary_ref: cfg.primaryRef, distinct_from_primary: true });

// OpenAPI root is an administrative probe, never a public-key validity probe.
try {
  const r = await fetch(cfg.apiUrl + '/rest/v1/', { headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey, Accept: 'application/openapi+json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Object.assign(new Error(), { code: 'HTTP_' + r.status });
  const doc = await r.json();
  if (!doc.swagger && !doc.openapi) throw Object.assign(new Error(), { code: 'UNEXPECTED_API_RESPONSE' });
  output('CUTOVER_SUPABASE_SERVICE_ROLE_KEY', 'OK', { project_ref: cfg.projectRef, role: 'service_role', http_status: r.status });
} catch(error) {
  output('CUTOVER_SUPABASE_SERVICE_ROLE_KEY', 'FAIL', {project_ref: cfg.projectRef, error_type: safeErrorCode(error)});process.exit(1);
}
try {
  const result = await publicKeySanityCheck(cfg.apiUrl, cfg.anonKey);
  output('CUTOVER_SUPABASE_ANON_KEY', 'OK', {project_ref: cfg.projectRef, role: 'anon', ...result});
} catch(error) {
  output('CUTOVER_SUPABASE_ANON_KEY', 'FAIL', {project_ref: cfg.projectRef, error_type: safeErrorCode(error)});process.exit(1);
}
output('CUTOVER_SUPABASE_URL', 'OK', { project_ref: cfg.projectRef });

let clients = [];
let failed = false;
try {
  const ca = readFileSync(new URL('../../worker/.cutover/prod-ca-2021.crt', import.meta.url), 'utf8');
  const certificate = new X509Certificate(ca);
  if (!certificate.ca || Date.parse(certificate.validTo) <= Date.now()) throw Object.assign(new Error(), {code:'CA_INVALID_OR_EXPIRED'});
  const { Client } = await import('pg');
  clients = [0, 1].map(() => {
    const c = new Client({ connectionString: cfg.databaseUrl, ssl: { rejectUnauthorized: true, ca }, connectionTimeoutMillis: 12000, application_name: 'forge-cutover-readonly-check', query_timeout: 10000 });
    if (c.connectionParameters.ssl?.rejectUnauthorized !== true || c.connectionParameters.ssl?.ca !== ca) throw Object.assign(new Error(), {code:'TLS_CONFIGURATION_OVERRIDDEN'});
    c.on('error', () => {}); // Never let raw driver messages leak the connection string.
    return c;
  });
  await clients[0].connect(); clients[0].cutoverConnected = true;
  if (clients[0].connection.stream.authorized !== true || clients[0].connection.stream.encrypted !== true) throw Object.assign(new Error(), {code:'TLS_NOT_VERIFIED'});
  output('database_tls', 'OK', {project_ref:cfg.databaseRef, certificate_verified:true, reject_unauthorized:true, ca_path:'app/worker/.cutover/prod-ca-2021.crt'});
  await clients[0].query('BEGIN READ ONLY');
  const single = await clients[0].query("select pg_backend_pid() pid, current_setting('transaction_read_only') read_only");
  if (single.rows[0]?.read_only !== 'on') throw Object.assign(new Error(), {code:'READ_ONLY_NOT_CONFIRMED'});
  output('database_single_connection', 'OK', {project_ref:cfg.databaseRef, backend_pid:single.rows[0].pid, read_only:true});
  await clients[1].connect(); clients[1].cutoverConnected = true;
  if (clients[1].connection.stream.authorized !== true || clients[1].connection.stream.encrypted !== true) throw Object.assign(new Error(), {code:'TLS_NOT_VERIFIED'});
  await clients[1].query('BEGIN READ ONLY');
  const results = await Promise.all(clients.map(c => c.query("select pg_backend_pid() pid, current_database() db, current_user db_user, current_setting('transaction_read_only') read_only")));
  const pids=results.map(r=>r.rows[0]?.pid);
  if (results.some(r => r.rows[0]?.read_only !== 'on') || pids.some(p=>!Number.isInteger(p)) || pids[0]!==single.rows[0].pid || pids[0]===pids[1]) throw Object.assign(new Error(), { code: 'INDEPENDENT_BACKENDS_NOT_CONFIRMED' });
  output('CUTOVER_DATABASE_URL', 'OK', { project_ref: cfg.databaseRef, independent_connections: 2, backend_pids:pids, distinct_backend_pids: true, read_only_transactions: true });
  // Read-only inventory helps prevent migrating over a non-empty application schema later.
  const inventory = await clients[0].query("select count(*)::int tables from information_schema.tables where table_schema='public' and table_type='BASE TABLE'");
  const stale=await clients[0].query("select (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname ~ '^ita_')::int functions,(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname ~ '^ita_')::int relations");
  if(inventory.rows[0].tables!==0||stale.rows[0].functions!==0||stale.rows[0].relations!==0)throw Object.assign(new Error(),{code:'FRESH_SCHEMA_REQUIRED'});
  output('disposable_schema_inventory', 'OK', { public_tables: inventory.rows[0].tables,...stale.rows[0],fresh:true });
} catch (error) {
  failed = true;
  output('CUTOVER_DATABASE_URL', 'FAIL', { project_ref: cfg.databaseRef, error_type: safeErrorCode(error) });
} finally {
  await Promise.allSettled(clients.map(async c => {
    const timer = setTimeout(() => c.connection?.stream?.destroy(), 1500);
    try { if(c.cutoverConnected) await c.query('ROLLBACK').catch(()=>{}); await c.end(); } finally { clearTimeout(timer); }
  }));
}
if (failed) process.exit(1);
output('preflight_complete', 'OK', { project_ref: cfg.projectRef, migrations_executed: false });
