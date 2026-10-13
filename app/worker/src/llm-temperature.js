/** Trusted request preference; optional provider/caller parameters cannot override it. */
export function parseOmitTemperature(value) {
  if (value == null || value === '' || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw Object.assign(new Error('LLM_OMIT_TEMPERATURE 必须是 true 或 false'), { code: 'LLM_TEMPERATURE_CONFIG' });
}

export function resolveTemperatureOmission(settings) {
  return { omitTemperature: parseOmitTemperature(settings.llmOmitTemperature) };
}
