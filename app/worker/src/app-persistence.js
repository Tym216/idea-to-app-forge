/** Browser app data is independent of code/checkpoint/runtime identity. */
export const PERSISTENCE_SOURCE = String.raw`
export function createAppState(collection, { schemaVersion = 1, initialValue = null, migrate = null, storage = null } = {}) {
  if (typeof collection !== 'string' || !collection.trim() || !Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error('Invalid app-state configuration');
  const key = ['forge', FORGE_APPLICATION.environment, FORGE_APPLICATION.project, collection].map(encodeURIComponent).join(':');
  const read = () => {
    try {
      storage ||= globalThis.localStorage;
      const raw = storage.getItem(key);
      if (raw === null) return { value: initialValue, status: 'empty' };
      const record = JSON.parse(raw);
      if (!record || !Number.isInteger(record.schemaVersion) || !Object.prototype.hasOwnProperty.call(record, 'value')) throw new Error('Invalid persisted state');
      if (record.schemaVersion === schemaVersion) return { value: record.value, status: 'restored' };
      if (record.schemaVersion > schemaVersion || typeof migrate !== 'function') throw new Error('Unsupported app-data schema');
      const value = migrate(record.value, record.schemaVersion, schemaVersion);
      if (value === undefined) throw new Error('Migration returned no value');
      return { value, status: 'migrated' };
    } catch (error) { return { value: initialValue, status: 'blocked', error: String(error.message || error) }; }
  };
  const write = (value) => {
    if (read().status === 'blocked') throw new Error('Original app data retained; repair/export it before saving');
    const encoded = JSON.stringify({ schemaVersion, value });
    if (!Object.prototype.hasOwnProperty.call(JSON.parse(encoded), 'value')) throw new Error('App state is not serializable; original data retained');
    storage.setItem(key, encoded);
  };
  return { key, read, write };
}
`;
export const PERSISTENCE_GUIDANCE = "明确需要长期保留的用户/业务状态（Todo、笔记、游戏进度、偏好）使用 src/forge-persistence.ts 的 createAppState(collection,{schemaVersion,initialValue,migrate?})。读 read() 的 value/status；blocked 时提示原数据无法读取且禁止写入，不要用空默认值自动覆盖。写入通过 write(value)。collection 与 app-data schemaVersion 在兼容迭代中保持稳定；不要绑定代码版本/task/sandbox。临时弹窗/hover 等仍用内存。对持久数据的验收包含 reload 后保留；不代表跨设备或跨预览 origin 同步。";

export function renderPersistenceHelper(environment, project) {
  if (!environment || !project) throw new Error('Persistence requires a stable application identity');
  return 'const FORGE_APPLICATION = ' + JSON.stringify({ environment, project }) + ';\n' + PERSISTENCE_SOURCE;
}
