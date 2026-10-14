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
  // Only an explicit user-confirmed reset may discard even malformed/older app data.
  const reset = () => {
    storage ||= globalThis.localStorage;
    const encoded = JSON.stringify({ schemaVersion, value: initialValue });
    if (!Object.prototype.hasOwnProperty.call(JSON.parse(encoded), 'value')) throw new Error('Initial state is not serializable; original data retained');
    storage.setItem(key, encoded);
  };
  return { key, read, write, reset };
}
`;
export const PERSISTENCE_GUIDANCE = "所有生成应用默认保留用户已经产生的业务状态，刷新、退出 Forge 后重新登录、兼容代码迭代都不得自动清空。React 优先用 src/forge-use-app-state.ts 的 useAppState(collection,{schemaVersion,initialValue,migrate?})，返回 {value,setValue,status,error,reset}；setValue 支持函数式更新并同步保存后才更新 UI。普通逻辑可用 src/forge-persistence.ts 的 createAppState/read/write。游戏必须保存完整局面（棋盘/蛇身、当前分数、方向、关卡、进度、随机目标等），不能只保存最高分；页面重新打开先恢复局面并暂停计时，用户继续后才推进，避免离开后丢分或死亡。数据型应用保存所有条目及完成/设置状态。collection、environment/project namespace 和 app-data schema 在兼容迭代中保持稳定，不绑定 App Version/task/sandbox；不在 mount、logout 或 build 时 reset。提供用户可发现的「重置业务数据」入口，确认后仅调用自己的集合 reset，禁止 localStorage.clear()。blocked 时显示错误并保留原数据，不能自动覆盖为空。弹窗/hover 等真正临时 UI 状态可留内存。新生成验收包含 reload 后完整状态保留。应用通过 Forge 预览时，平台桥接将 localStorage 存在 Forge origin，按环境/账号/项目隔离，Daytona URL 与 App Version 变化不改变数据空间。直接预览会进入 Forge 托管的预览页。不声称跨设备同步；未写入存储的任意内存不能自动恢复。";

export function renderPersistenceHelper(environment, project) {
  if (!environment || !project) throw new Error('Persistence requires a stable application identity');
  return 'const FORGE_APPLICATION = ' + JSON.stringify({ environment, project }) + ';\n' + PERSISTENCE_SOURCE;
}

export const PERSISTENCE_HOOK_SOURCE = "import {useCallback,useRef,useState} from 'react';\nimport {createAppState} from './forge-persistence';\n\n/** One durable business-state collection per hook; synchronous save before UI update. */\nexport function useAppState(collection, options = {}) {\n const state=useRef(null);\n if(!state.current){\n  const store=createAppState(collection,options);\n  state.current={store,value:store.read()};\n }\n const [snapshot,setSnapshot]=useState(state.current.value);\n const setValue=useCallback(next=>{\n  const current=state.current;\n  if(current.value.status==='blocked')return false;\n  try{\n   const value=typeof next==='function'?next(current.value.value):next;\n   current.store.write(value);\n   current.value={value,status:'saved'};\n   setSnapshot(current.value);\n   return true;\n  }catch(error){\n   current.value={...current.value,status:'blocked',error:String(error.message||error)};\n   setSnapshot(current.value);return false;\n  }\n },[]);\n const reset=useCallback(()=>{\n  const current=state.current;\n  try{\n   if(typeof current.store.reset==='function')current.store.reset();\n   else current.store.write(options['initialValue']===undefined?null:options['initialValue']);\n   current.value=current.store.read();\n   setSnapshot(current.value);return true;\n  }catch(error){\n   current.value={...current.value,status:'blocked',error:String(error.message||error)};\n   setSnapshot(current.value);return false;\n  }\n },[]);\n return {value:snapshot.value,setValue,status:snapshot.status,error:snapshot.error||null,reset};\n}\n";
