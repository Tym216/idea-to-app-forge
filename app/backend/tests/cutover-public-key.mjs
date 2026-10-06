/** Public API-key validation without a user session or schema mutations. Never use OpenAPI root. */
export async function publicKeySanityCheck(apiUrl, key, fetcher = fetch) {
  const get = (path) => fetcher(apiUrl + path, { method: 'GET', headers: { apikey: key, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const settings = await get('/auth/v1/settings');
  if (!settings.ok) throw Object.assign(new Error(), { code: 'PUBLIC_AUTH_HTTP_' + settings.status });
  const body = await settings.json();
  if (typeof body.external !== 'object' && typeof body.disable_signup !== 'boolean') throw Object.assign(new Error(), { code: 'PUBLIC_AUTH_RESPONSE_INVALID' });
  // A guaranteed probe-name lookup performs no read/write of application records.
  const data = await get('/rest/v1/__forge_cutover_readonly_missing_probe?select=*&limit=0');
  let error; try { error = await data.json(); } catch { error = {}; }
  if (data.status !== 404 || error.code !== 'PGRST205') throw Object.assign(new Error(), { code: 'PUBLIC_DATA_HTTP_' + data.status });
  return { auth_settings_status: 200, data_api_status: 404, data_api_code: 'PGRST205', authorization_header_sent: false };
}
