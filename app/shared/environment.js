export const MAIN_REF = 'vfzyimhapttcdxeabvur';
export const RESTORE_REF = 'zynvesyeqsoeqssgwubj';
export function projectRef(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash
    ? /^([a-z]{20})\.supabase\.co$/.exec(u.hostname)?.[1] || null : null; } catch { return null; }
}
export function environmentProblems({ environmentId, expectedRef, supabaseUrl, explicit = true }) {
  const errors = [];
  if (!['atoms-demo', 'production-main'].includes(environmentId)) errors.push('FORGE_ENVIRONMENT_ID must be explicit: atoms-demo or production-main');
  if (!/^[a-z]{20}$/.test(expectedRef || '')) errors.push('EXPECTED_SUPABASE_PROJECT_REF must be explicit');
  const actual = projectRef(supabaseUrl);
  if (!actual || actual !== expectedRef) errors.push('Supabase URL / expected project ref mismatch');
  if (environmentId === 'atoms-demo' && [MAIN_REF, RESTORE_REF].includes(expectedRef)) errors.push('atoms-demo cannot target Main or restore-test');
  if (environmentId === 'atoms-demo' && !explicit) errors.push('atoms-demo requires an explicit env source; default .env fallback forbidden');
  if (environmentId === 'production-main' && expectedRef !== MAIN_REF) errors.push('production-main must explicitly target Main');
  return errors;
}
export function assertEnvironment(values) {
  const errors = environmentProblems(values);
  if (errors.length) { const e = new Error('ENVIRONMENT_ISOLATION: ' + errors.join('; ')); e.code = 'ENVIRONMENT_ISOLATION'; throw e; }
  return { environmentId: values.environmentId, projectRef: values.expectedRef };
}

export function assertKeyProject(key, expectedRef) {
  if (!key || /placeholder/i.test(key)) throw new Error('ENVIRONMENT_ISOLATION: explicit API key required');
  if (key.startsWith('eyJ')) {
    let ref;
    try { ref = JSON.parse(atob(key.split('.')[1].replaceAll('-','+').replaceAll('_','/'))).ref; } catch { throw new Error('ENVIRONMENT_ISOLATION: invalid legacy API key'); }
    if (ref !== expectedRef) throw new Error('ENVIRONMENT_ISOLATION: API key project mismatch');
  }
}
